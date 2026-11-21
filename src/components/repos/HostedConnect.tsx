import Link from "next/link";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { listInstallationRepos } from "@/lib/services/installation-repos";
import { trackInstallationReposAction } from "@/app/actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { FolderGit2, Globe, Lock } from "@/components/ui/icons";

/**
 * The hosted "Connect repositories" page. It lists what THIS workspace's own GitHub connection can access (read live with the
 * connection's token, never a person's credential), and an administrator picks which repositories enter the workspace. Tracking
 * does not give anyone access to a repository: people see repositories through grants.
 */
export async function HostedConnect({ viewer }: { viewer: Viewer }) {
  const list = await listInstallationRepos(db, viewer.workspaceId);
  const header = <PageHeader title="Connect repositories" subtitle="Repositories your workspace's GitHub connection can read. Choosing one starts tracking it here; it does not change access on GitHub or who in this workspace can see it." />;

  if (list.state === "not-connected") {
    return (
      <>
        {header}
        <Panel title="Available repositories" icon={FolderGit2} id="available">
          <EmptyState icon={FolderGit2} title="GitHub is not connected yet" action={<Link href="/repositories" className="btn">Back to repositories</Link>}>
            Repository sync and GitHub actions are off. Your workspace data is still here. The owner or an administrator can connect GitHub for this workspace.
          </EmptyState>
        </Panel>
      </>
    );
  }
  if (list.state === "suspended") {
    return (
      <>
        {header}
        <Panel title="Available repositories" icon={FolderGit2} id="available">
          <EmptyState icon={FolderGit2} title="The GitHub connection is paused" action={<Link href="/repositories" className="btn">Back to repositories</Link>}>
            The account owner suspended the GitHub App on GitHub. Tracked repositories keep their last synced data and update again once it is resumed.
          </EmptyState>
        </Panel>
      </>
    );
  }
  if (!viewer.isAdmin) {
    return (
      <>
        {header}
        <Panel title="Available repositories" icon={FolderGit2} id="available">
          <EmptyState icon={FolderGit2} title="Only an administrator chooses repositories" action={<Link href="/repositories" className="btn">Back to repositories</Link>}>
            Ask the owner or an administrator to track a repository, and to give you access to it.
          </EmptyState>
        </Panel>
      </>
    );
  }
  return (
    <>
      {header}
      {list.problems.map((p) => <div key={p} className="mb-3"><Banner tone="warn" title="One connection could not be read">{p}</Banner></div>)}
      {list.truncated && <div className="mb-3"><Banner tone="info" title="Long list">Only the first repositories of a large connection are listed.</Banner></div>}
      <Panel title={`Available repositories (${list.repos.length})`} icon={FolderGit2} id="available">
        {list.repos.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No repositories listed">The GitHub App has no repository access yet. Add repositories to the installation on GitHub, then reload this page.</EmptyState>
        ) : (
          <ActionForm action={trackInstallationReposAction} submitLabel="Track selected" pendingLabel="Tracking…" className="flex flex-col" success={{ link: { href: "/repositories", label: "Open Repositories" } }}>
            <ul className="max-h-[60vh] overflow-y-auto">
              {list.repos.map(({ meta, tracked }) => (
                <li key={meta.githubId.toString()} className="border-b border-line last:border-b-0">
                  <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] hover:bg-faint has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                    <input type="checkbox" name="repo" value={meta.githubId.toString()} disabled={tracked} />
                    <span className="min-w-0 flex-1 basis-[12rem] [overflow-wrap:anywhere]"><Mono>{meta.fullName}</Mono></span>
                    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                      {meta.archived && <span title="Archived on GitHub: read only for everyone.">Archived</span>}
                      {meta.isFork && <span title={meta.parentFullName ? `Fork of ${meta.parentFullName}` : "Fork"}>Fork</span>}
                      <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-ink-2">{meta.visibility === "PUBLIC" ? <Globe size={12} aria-hidden /> : <Lock size={12} aria-hidden />}{meta.visibility === "PUBLIC" ? "public" : "private"}</span>
                    </span>
                    {tracked && <SimplePill tone="ok">Tracked</SimplePill>}
                  </label>
                </li>
              ))}
            </ul>
          </ActionForm>
        )}
      </Panel>
      <p className="mt-3 text-[12px] text-ink-3"><Link className="underline" href="/repositories">Back to repositories</Link></p>
    </>
  );
}
