import { describeAccess, type RepoPermissions } from "@/lib/domain/repo-access";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listRepositories } from "@/lib/services/queries";
import { repoWhere } from "@/lib/authz/viewer";
import { formatDuration } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner, PageHeader, Panel } from "@/components/ui/primitives";
import { FolderGit2, Plus } from "@/components/ui/icons";
import { importPublicAction } from "@/app/actions";
import { ConnectReposEmpty, ConnectReposLink, canConnectRepos } from "@/components/repos/ConnectRepos";
import { RepoList, type RepoRow } from "@/components/repos/RepoList";

export const metadata = { title: "Repositories" };

export default async function Repositories({ searchParams: _searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { viewer } = await requireViewer();
  const now = new Date();
  const repos = await listRepositories(db, viewer);
  // A fork's parent name is shown only if that parent is not a tracked repository hidden from this viewer.
  const parentIds = repos.map((r) => r.parentGithubId).filter((x): x is bigint => x !== null);
  const [trackedParents, visibleParents] = await Promise.all([
    db.repository.findMany({ where: { workspaceId: viewer.workspaceId, githubId: { in: parentIds } }, select: { githubId: true } }),
    db.repository.findMany({ where: { AND: [repoWhere(viewer), { githubId: { in: parentIds } }] }, select: { githubId: true } }),
  ]);
  const hiddenParents = new Set(trackedParents.map((p) => p.githubId.toString()));
  for (const v of visibleParents) hiddenParents.delete(v.githubId.toString());
  const rows: RepoRow[] = repos.map((r) => {
    const acc = describeAccess(r.permissions as RepoPermissions);
    return {
      id: r.id,
      name: r.name,
      fullName: r.fullName,
      ownerLogin: r.owner.login,
      ownerAvatar: r.owner.avatarUrl,
      ownerType: r.owner.type,
      visibility: r.visibility,
      access: { label: acc.label, detail: acc.detail },
      archived: r.archived,
      demo: r.isDemo,
      fork: r.isFork ? { of: r.parentGithubId !== null && hiddenParents.has(r.parentGithubId.toString()) ? "an upstream not shared with you" : r.parentFullName } : null,
      openItems: r.lastSyncedAt ? r._count.workItems : null,
      status: r.trackingStatus === "DISCONNECTED" ? "disconnected" : r.rateLimited ? "rate" : r.syncError ? "failed" : "ok",
      statusDetail: r.statusDetail ?? r.syncError ?? null,
      synced: r.lastSyncedAt ? formatDuration(now.getTime() - r.lastSyncedAt.getTime()) : "never synced",
      syncedAt: r.lastSyncedAt ? `Last synced ${r.lastSyncedAt.toISOString().replace("T", " ").slice(0, 19)} UTC` : null,
      projects: r.projects.map((p) => p.project.name),
    };
  });
  const canConnect = canConnectRepos(viewer);
  const problems = repos.filter((r) => r.trackingStatus === "DISCONNECTED" || r.rateLimited || r.syncError);

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="Repositories tracked in this workspace. People see only the repositories they have been granted."
        actions={canConnect ? <ConnectReposLink canConnect><Plus size={14} aria-hidden /> Connect repositories</ConnectReposLink> : undefined}
      />

      {problems.length > 0 && (
        <div className="mb-4">
          <Banner tone={problems.some((r) => r.trackingStatus === "DISCONNECTED") ? "error" : "warn"} title={`${problems.length} repositor${problems.length === 1 ? "y has" : "ies have"} stale data.`}>
            Filter: Needs attention.
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[12px] opacity-80">Details</summary>
              <p className="mt-1 text-[12px]">
                {problems.some((r) => r.trackingStatus === "DISCONNECTED")
                  ? "A disconnected repository was deleted, renamed or lost your access on GitHub. Its numbers are from the last sync. If it is gone for good, use “Stop tracking” in its row menu. "
                  : `${problems.length === 1 ? "Its numbers are" : "Their numbers are"} from the last successful sync, not from GitHub right now (often a short outage or rate limit that clears by itself). `}
                Use the “Needs attention” filter below to see which, and “Refresh” to try again.
              </p>
              <ul className="mt-1 list-disc pl-5 text-[12px]">
                {problems.slice(0, 12).map((r) => <li key={r.id}><strong className="font-medium">{r.fullName}</strong>: {r.trackingStatus === "DISCONNECTED" ? "disconnected" : r.rateLimited ? "GitHub rate limit reached" : "last sync failed"}{(r.statusDetail ?? r.syncError) ? ` (${r.statusDetail ?? r.syncError})` : ""}</li>)}
                {problems.length > 12 && <li>and {problems.length - 12} more</li>}
              </ul>
            </details>
          </Banner>
        </div>
      )}

      <Panel title={`Tracked repositories (${repos.length})`} icon={FolderGit2} id="repos"
        actions={!viewer.isAdmin ? undefined :
          <ActionForm action={importPublicAction} submitLabel="Track" pendingLabel="Checking…" className="flex w-full items-center gap-2 sm:w-auto [&>div]:!mt-0" submitClassName="btn btn-primary !h-8">
            <label className="sr-only" htmlFor="pub-url">Public repository URL or owner/repo</label>
            <input id="pub-url" name="repo" className="input !h-8 !w-full sm:!w-60" placeholder="Public URL or owner/repo" required />
          </ActionForm>
        }>
        {repos.length === 0 ? (
          <ConnectReposEmpty canConnect={canConnect} title="No repositories yet">
            Import a public repository by URL, or choose from repositories your GitHub account can access.
          </ConnectReposEmpty>
        ) : (
          <RepoList rows={rows} />
        )}
      </Panel>
    </>
  );
}
