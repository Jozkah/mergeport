import { redirect } from "next/navigation";
import { createWorkspaceAction } from "@/app/account-actions";
import { AuthShell } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { RoleChip } from "@/components/ui/identity";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { getAuth } from "@/lib/auth/current";
import { acceptPendingInviteAction } from "@/app/invite/actions";
import { db } from "@/lib/db";
import { pendingInvitationsFor } from "@/lib/services/invitations";

export const metadata = { title: "Create a workspace" };
export const dynamic = "force-dynamic";

/** First stop after a first email or OIDC sign-in: the person belongs to no workspace yet. */
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ error?: string; name?: string }> }) {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  if (a.viewer) redirect("/");
  const sp = await searchParams;
  const invites = await pendingInvitationsFor(db, { id: a.user.id, email: a.user.email, emailVerifiedAt: a.user.emailVerifiedAt });
  const hasInvites = invites.length > 0;
  const typed = typeof sp.name === "string" ? sp.name.slice(0, 80) : "";
  const create = (
    <>
      <p className="mt-2 text-[13px] text-ink-3">A workspace holds your team&apos;s projects and repositories. You will be its owner.</p>
      {sp.error && <div className="mt-4"><Banner tone="error" title="Could not create it">{sp.error === "invite" ? "That invitation is no longer valid." : sp.error === "limit" ? "You have created several workspaces today. Try again tomorrow." : sp.error === "name" ? "Give the workspace a name of up to 80 characters." : "Something went wrong. Try again."}</Banner></div>}
      <form action={createWorkspaceAction} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-ink-2">Workspace name</span>
          <input className="input input-lg" name="name" required maxLength={80} autoComplete="off" spellCheck={false} placeholder="Acme engineering" defaultValue={typed} />
        </label>
        <SubmitButton className={`btn btn-lg w-full ${hasInvites ? "" : "btn-primary"}`} pendingLabel="Creating…">Create workspace</SubmitButton>
      </form>
    </>
  );
  const identity = (
    <div className="flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
      <span className="min-w-0 truncate">Signed in as <bdi className="text-ink-2">{a.user.email ?? a.user.login}</bdi></span>
      <form action="/auth/signout" method="post"><SubmitButton className="btn btn-quiet shrink-0" pendingLabel="Signing out…">Sign out</SubmitButton></form>
    </div>
  );
  if (!hasInvites) return <AuthShell title="Create your workspace" aside={identity}>{create}</AuthShell>;
  return (
    <AuthShell
      title="You have been invited"
      aside={
        <>
          <div className="panel">
            <div className="panel-body p-5">
              <h2 className="text-[16px] font-medium">Or create your own workspace</h2>
              {create}
            </div>
          </div>
          {identity}
        </>
      }
    >
      <p className="mt-2 text-[13px] text-ink-3">Join a workspace you were invited to, or create your own below.</p>
      <ul className="mt-3 flex flex-col gap-3">
        {invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]"><strong className="wrap-any font-medium"><bdi>{i.workspaceName}</bdi></strong> <RoleChip role={i.role} /></span>
            <form action={acceptPendingInviteAction}>
              <input type="hidden" name="invitationId" value={i.id} />
              <SubmitButton className="btn btn-primary btn-lg" pendingLabel="Joining…" aria-label={`Join workspace ${i.workspaceName}`}>Join workspace</SubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </AuthShell>
  );
}
