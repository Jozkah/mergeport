import { AuthShell } from "@/components/ui/AuthShell";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { AccountSignIn } from "@/components/forms/AccountSignIn";
import { isHosted } from "@/lib/public-url";
import { isDemo } from "@/lib/env";
import { Banner } from "@/components/ui/primitives";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "demo-unseeded": "Demo data has not been seeded. Run npm run demo, then reload this page.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string; next?: string; email?: string }> }) {
  const sp = await searchParams;
  // A hosted deployment (MERGEPORT_PUBLIC_URL) signs people in with email or OIDC. The only other way in is the demo's synthetic people.
  if (isHosted()) return <AccountSignIn error={sp.error} sent={sp.sent === "1"} next={sp.next} email={sp.email} />;
  const demo = isDemo();
  return (
    <AuthShell
      title={demo ? "Sign in to the demo" : "Sign in"}
      badge={demo ? <span className="pill pill-neutral ml-auto">Demo</span> : undefined}
      aside={
        demo ? (
          <div className="panel">
            <div className="panel-head"><h2 className="text-[13px] font-medium text-ink-2">Demo people (synthetic)</h2></div>
            <form action="/api/local/demo" method="post" className="panel-body flex flex-col gap-2 p-3">
              <SubmitButton name="as" value="admin" className="btn justify-start" pendingLabel="Signing in…">Owner · owner-demo (sees everything)</SubmitButton>
              <SubmitButton name="as" value="alice" className="btn justify-start" pendingLabel="Signing in…">Member A · alice-demo (3 repositories)</SubmitButton>
              <SubmitButton name="as" value="bram" className="btn justify-start" pendingLabel="Signing in…">Member B · bram-demo (2 repositories)</SubmitButton>
            </form>
          </div>
        ) : undefined
      }
    >
      <>
        {sp.error && <div className="mt-4"><Banner tone="error" title="Could not sign you in">{ERRORS[sp.error] ?? "Something went wrong."}</Banner></div>}
        {demo ? (
          <p className="mt-2 text-[13px] text-ink-3">Demo mode uses synthetic data and never contacts GitHub.</p>
        ) : (
          <p className="mt-2 text-[13px] text-ink-3">Sign-in needs a hosted deployment: set <span className="mono">MERGEPORT_PUBLIC_URL</span> (see docs/auth.md), or run <span className="mono">npm run demo</span> for synthetic data.</p>
        )}
      </>
    </AuthShell>
  );
}
