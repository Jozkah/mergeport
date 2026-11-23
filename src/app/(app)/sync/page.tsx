import { processStartedAt } from "@/lib/local/boot";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { isDemo } from "@/lib/env";
import { formatInstant } from "@/lib/format";
import { deriveSourceStatus } from "@/lib/sync/source-status";
import { SyncBadge } from "@/components/sync/SyncBadge";
import { Banner, EmptyState, Mono, PageHeader, Panel } from "@/components/ui/primitives";
import { FolderGit2, RefreshCw } from "@/components/ui/icons";

export const metadata = { title: "Sync" };
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const { viewer } = await requireViewer();
  // A job still marked RUNNING by a process that died is not work in progress; it is reclaimed on a timer.
  const bootAt = processStartedAt();
  const own = { isDemo: false, trackingStatus: { not: "REMOVED" as const } };
  const sourceRepos = await db.repository.findMany({ where: { AND: [repoWhere(viewer), own] }, select: { id: true, fullName: true, trackingStatus: true, rateLimited: true, syncError: true, statusDetail: true, lastSyncedAt: true }, orderBy: { fullName: "asc" } });
  const [running, queued] = await Promise.all([db.job.count({ where: { workspaceId: viewer.workspaceId, type: "sync.repository", status: "RUNNING", lockedAt: { gte: bootAt } } }), db.job.count({ where: { workspaceId: viewer.workspaceId, type: "sync.repository", status: "QUEUED" } })]);
  const source = deriveSourceStatus({
    tracked: sourceRepos.length, running, queued,
    refused: sourceRepos.filter((r) => r.trackingStatus === "DISCONNECTED").length,
    rateLimited: sourceRepos.filter((r) => r.rateLimited).length,
    failed: sourceRepos.filter((r) => r.trackingStatus === "ACTIVE" && !r.rateLimited && r.syncError).length,
    neverSynced: sourceRepos.filter((r) => !r.lastSyncedAt).length,
  });
  const sourceProblems = sourceRepos.filter((r) => r.trackingStatus === "DISCONNECTED" || r.rateLimited || r.syncError);
  const lastSource = sourceRepos.reduce<Date | null>((m, r) => (r.lastSyncedAt && (!m || r.lastSyncedAt > m) ? r.lastSyncedAt : m), null);
  return (
    <>
      <PageHeader title="Sync" subtitle="What was last refreshed from GitHub, and what needs attention."
        help={<>Repository data is refreshed from GitHub in the background: on webhook deliveries and on a regular reconcile run. Use Refresh on a repository to ask for it sooner.</>}
      />
      {isDemo() && <div className="mb-4"><Banner title="Demo mode">Nothing syncs in demo mode.</Banner></div>}

      {source && (
        <div className="mb-5">
          <Panel title={`Tracked repositories (${sourceRepos.length})`} icon={FolderGit2} id="source" actions={<SyncBadge state={source.state} detail={source.detail} scope="source" />}>
            <div className="flex flex-col gap-2 p-4 text-[13px]">
              <p>{source.detail}</p>
              <p className="text-[12px] text-ink-3">{lastSource ? `Last successful refresh ${formatInstant(lastSource, viewer.timezone)}.` : "No repository has been refreshed yet."} Refreshing only reads from GitHub; it never changes a repository.</p>
              {sourceProblems.length > 0 && (
                <ul className="mt-1 divide-y divide-line rounded-[8px] border border-line">
                  {sourceProblems.slice(0, 20).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-[12.5px]"><Mono>{r.fullName}</Mono><span className="text-ink-3">{r.trackingStatus === "DISCONNECTED" ? "access refused" : r.rateLimited ? "rate limited" : "last refresh failed"}: {r.statusDetail ?? r.syncError}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      )}

      {!source && <Panel title="Tracked repositories" icon={RefreshCw} id="source"><EmptyState icon={RefreshCw} title="Nothing to sync yet">Repository data is refreshed from GitHub in the background. Nothing else needs syncing.</EmptyState></Panel>}
    </>
  );
}
