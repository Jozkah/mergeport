import { notFound } from "next/navigation";
import { AuthShell, OrDivider } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { getAuth } from "@/lib/auth/current";
import { setupTokenValid } from "@/lib/auth/setup";
import { isHosted } from "@/lib/public-url";

// The token is in the address: it must not travel to another site in Referer.
export const metadata = { title: "Set up Mergeport", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "email-invalid": "That does not look like an email address. Check it and try again.",
  "rate-limited": "Too many attempts. Wait a few minutes and try again.",
  "signed-out": "Your session has ended. Enter your address below instead.",
};

/**
 * The setup link printed at server start (src/lib/auth/setup.ts). Shows the form only while the link is valid and nobody is server
 * administrator; otherwise the same 404 as any missing page. Opening the page uses nothing up: only the form's POST does.
 */
export default async function Setup({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  if (!isHosted() || isDemo()) notFound();
  const { token } = await params;
  if (!(await setupTokenValid(db, token))) notFound();
  const error = (await searchParams).error;
  const auth = await getAuth();
  const form = (
    <form action="/setup/claim" method="post" className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium text-ink-2">Email</span>
        <input className="input input-lg" name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium text-ink-2">Name</span>
        <input className="input input-lg" name="name" maxLength={100} autoComplete="name" />
      </label>
      <SubmitButton className={`btn btn-lg w-full ${auth ? "" : "btn-primary"}`} pendingLabel="Creating…">Create the administrator</SubmitButton>
    </form>
  );
  return (
    <AuthShell title="Set up this server">
      <p className="mt-2 text-[13px] text-ink-3">The server administrator sets up outgoing email (Settings &gt; Email), so people can sign in by email and receive invitations. This link works once.</p>
      {error && ERRORS[error] && <div className="mt-4"><Banner tone="error" title="Could not set up">{ERRORS[error]}</Banner></div>}
      {auth ? (
        <>
          <form action="/setup/claim" method="post" className="mt-4">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="mode" value="me" />
            <SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Saving…">Make me the administrator ({auth.user.email ?? auth.user.login})</SubmitButton>
          </form>
          <OrDivider />
          <p className="text-[13px] text-ink-3">Or name someone else. This browser is then signed in as them.</p>
          {form}
        </>
      ) : (
        form
      )}
    </AuthShell>
  );
}
