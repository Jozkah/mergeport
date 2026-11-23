import { notFound, redirect } from "next/navigation";
import { AuthShell, ErrorScreen } from "@/components/ui/AuthShell";
import { ConsentForm } from "@/components/oauth/ConsentForm";
import { getAuth } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { isHosted } from "@/lib/public-url";
import { membershipsOf, parseAuthorize } from "@/lib/services/oauth";

/** Nothing is sent to other sites from here; "same-origin" (not "no-referrer") so the consent form keeps a real Origin header. */
export const metadata = { title: "Connect an app", referrer: "same-origin" };
export const dynamic = "force-dynamic";

/**
 * The OAuth authorization page (docs/mcp.md, "OAuth"). An ordinary session page: signed out goes to sign-in and comes back here. It
 * shows who is asking (the name an app registered itself with is NOT verified, so the address it will return to is shown too), lets the
 * person pick one of THEIR workspaces and the access, and only then issues a code. A client or redirect address that is not exactly a
 * registered pair is never redirected to.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isHosted()) notFound();
  const raw = await searchParams;
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined) q[k] = first;
  }
  const a = await getAuth();
  if (!a) redirect(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(q).toString()}`)}`);

  const parsed = await parseAuthorize(db, q);
  if (!parsed.ok && parsed.fatal) {
    return (
      <ErrorScreen title="This app cannot connect" href="/">
        {parsed.message} Nothing was shared. Go back to the app and start again.
      </ErrorScreen>
    );
  }
  if (!parsed.ok) {
    const u = new URL(parsed.redirectUri);
    u.searchParams.set("error", parsed.error);
    u.searchParams.set("error_description", parsed.description);
    if (parsed.state !== undefined) u.searchParams.set("state", parsed.state);
    redirect(u.toString());
  }
  const r = parsed.request;
  const workspaces = await membershipsOf(db, a.user.id);
  if (workspaces.length === 0) {
    return (
      <ErrorScreen title="You are not in a workspace yet" href="/onboarding" label="Set up a workspace">
        Create or join a workspace first, then connect the app again.
      </ErrorScreen>
    );
  }
  const host = new URL(r.redirectUri).host;
  return (
    <AuthShell title={<>Connect <bdi>{r.clientName}</bdi> to Mergeport?</>}>
      <p className="mt-2 text-[13px] text-ink-2 text-pretty">
        It will act as you, <bdi className="break-all font-medium">{a.user.email ?? `@${a.user.login}`}</bdi>, in the workspace you choose. It can look at tasks, open new ones, add comments, edit a task, move it between board columns and mark it done or reopen it. It cannot delete anything, and it never changes GitHub.
      </p>
      <p className="mt-2 text-[12px] text-ink-3 text-pretty">
        Anyone can register an app under any name, and Mergeport has not checked this one. After you allow it, you go to <span className="mono break-all" translate="no">{host}</span>. Only allow it if you started this connection.
      </p>
      <ConsentForm
        req={{ clientId: r.clientId, redirectUri: r.redirectUri, state: r.state, codeChallenge: r.codeChallenge, resource: r.resource }}
        csrf={a.session.csrfToken}
        workspaces={workspaces}
        wantsWrite={r.wantsWrite}
        defaultWorkspace={a.viewer?.workspaceId ?? ""}
      />
    </AuthShell>
  );
}
