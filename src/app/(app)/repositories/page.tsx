import { describeAccess, type RepoPermissions } from "@/lib/domain/repo-access";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listRepositories } from "@/lib/services/queries";
import { repoWhere } from "@/lib/authz/viewer";
import { formatDuration } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner, EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { FolderGit2, Plus, RefreshCw } from "@/components/ui/icons";
import { importPublicAction } from "@/app/actions";
import { RepoList, type RepoRow } from "@/components/repos/RepoList";

export const metadata = { title: "Repositories" };

export default async function Repositories({ searchParams: _searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { viewer } = await requireViewer();
  const now = new Date();
  const [repos, spaces] = await Promise.all([listRepositories(db, viewer), db.space.findMany({ where: { access: "OK" }, orderBy: [{ kind: "asc" }, { name: "asc" }] })]);
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const writable = spaces.filter((s) => s.canWrite);
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
    const sp = r.spaceId ? spaceById.get(r.spaceId) : undefined;
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
      synced: r.lastSyncedAt ? `synced ${formatDuration(now.getTime() - r.lastSyncedAt.getTime())} ago` : "never synced",
      spaceId: r.spaceId,
      spaceName: sp?.name ?? null,
      canUnshare: !!sp?.canWrite,
      projects: r.projects.map((p) => p.project.name),
    };
  });
  const problems = repos.filter((r) => r.trackingStatus === "DISCONNECTED" || r.rateLimited || r.syncError);

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="Repositories tracked on this computer, plus any a teammate shared with you. Tracking is private to you until you share a repository to a space."
        actions={<Link href="/repositories/connect" className="btn btn-primary"><Plus size={14} aria-hidden /> Connect repositories</Link>}
      />

      {problems.length > 0 && (
        <div className="mb-4">
          <Banner tone={problems.some((r) => r.trackingStatus === "DISCONNECTED") ? "error" : "warn"} title={`${problems.length} repositor${problems.length === 1 ? "y has" : "ies have"} stale data`}>
            Their numbers are from the last successful sync, not from GitHub right now (often a short GitHub outage or rate limit that clears by itself). Use the “Needs attention” filter below to see which, and “Refresh” to try again.
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[12px] opacity-80">Details</summary>
              <ul className="mt-1 list-disc pl-5 text-[12px]">
                {problems.slice(0, 12).map((r) => <li key={r.id}><strong className="font-medium">{r.fullName}</strong>: {r.trackingStatus === "DISCONNECTED" ? "disconnected" : r.rateLimited ? "GitHub rate limit reached" : "last sync failed"}{(r.statusDetail ?? r.syncError) ? ` (${r.statusDetail ?? r.syncError})` : ""}</li>)}
                {problems.length > 12 && <li>and {problems.length - 12} more</li>}
              </ul>
            </details>
          </Banner>
        </div>
      )}

      <Panel title={`Tracked repositories (${repos.length})`} icon={FolderGit2} id="repos"
        actions={
          <ActionForm action={importPublicAction} submitLabel="Track" pendingLabel="Checking…" className="flex w-full items-start gap-2 sm:w-auto" submitClassName="btn btn-primary">
            <label className="sr-only" htmlFor="pub-url">Public repository URL or owner/repo</label>
            <input id="pub-url" name="repo" className="input !w-full sm:!w-64" placeholder="Public URL or owner/repo" required />
          </ActionForm>
        }>
        {repos.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No repositories yet" action={<Link href="/repositories/connect" className="btn btn-primary">Connect repositories</Link>}>
            Import a public repository by URL, or choose from repositories your GitHub account can access.
          </EmptyState>
        ) : (
          <RepoList rows={rows} writable={writable.map((sp) => ({ id: sp.id, name: sp.name, everyone: sp.kind === "COMMON" }))} />
        )}
      </Panel>
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-3"><RefreshCw size={12} aria-hidden /> Stopping tracking removes it from the dashboard only. Nothing is deleted on GitHub.</p>
    </>
  );
}
