import Link from "next/link";
import { isHosted } from "@/lib/public-url";
import { processStartedAt } from "@/lib/local/boot";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { isDemo } from "@/lib/env";
import { getEngine, getTeamService } from "@/lib/local/runtime";
import { syncCenter } from "@/lib/services/sync-center";
import { MAX_POLL_MS, expectedConsistencyDelaySeconds } from "@/lib/sync/engine";
import { formatInstant } from "@/lib/format";
import { deriveSourceStatus } from "@/lib/sync/source-status";
import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { SyncBadge } from "@/components/sync/SyncBadge";
import { Banner, EmptyState, Mono, PageHeader, Panel, Time } from "@/components/ui/primitives";
import { FolderGit2, RefreshCw, ShieldCheck } from "@/components/ui/icons";
import { dismissRestoredAction, refreshSyncAction, releaseQuarantineAction, resendRestoredAction, resolveConflictAction } from "@/app/team-actions";

export const metadata = { title: "Sync" };
export const dynamic = "force-dynamic";

const val = (v: unknown) => (v === undefined || v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));

export default async function SyncPage() {
  const { viewer } = await requireViewer();
  const engine = await getEngine(viewer.workspaceId);
  const cfg = await db.teamConfig.findUnique({ where: { workspaceId: viewer.workspaceId } });
  const spaces = await db.space.findMany({ where: { workspaceId: viewer.workspaceId }, orderBy: { createdAt: "asc" } });
  const conflicts = await db.syncConflict.findMany({ where: { status: "OPEN", space: { workspaceId: viewer.workspaceId } }, include: { space: true }, orderBy: { createdAt: "asc" } });
  const restores = await db.hubRestore.findMany({ where: { status: "OPEN", space: { workspaceId: viewer.workspaceId } }, include: { space: true }, orderBy: { at: "asc" } });
  const quarantined = await db.outboxOp.findMany({ where: { status: "QUARANTINED", space: { workspaceId: viewer.workspaceId } }, include: { space: true } });
  const pendingOps = await db.outboxOp.findMany({ where: { status: { in: ["PENDING", "SENT", "FAILED"] }, space: { workspaceId: viewer.workspaceId } }, include: { space: true }, orderBy: { createdAt: "asc" }, take: 50 });
  const poll = cfg?.pollSeconds ?? 30;
  const delay = expectedConsistencyDelaySeconds(poll);
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
  const center = await syncCenter(db, viewer.workspaceId, poll);
  const teamSvc = await getTeamService(viewer.workspaceId);
  const quota = teamSvc && !isDemo() ? await Promise.race([teamSvc.rateLimit(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]) : null;
  const states = engine ? await Promise.all(spaces.map(async (s) => [s, await engine.stateFor(s)] as const)) : [];

  return (
    <>
      <PageHeader title="Sync" subtitle="Edits save here first. See what reached GitHub, what waits, and what needs a decision." actions={engine ? <ActionForm action={refreshSyncAction} submitLabel="Refresh now" submitClassName="btn" resetOnSuccess={false}>{null}</ActionForm> : undefined}
        help={<>Mergeport polls GitHub; it is not real time. With the app open and visible it checks every {poll} seconds, so a teammate&apos;s change typically shows up within about {delay.typical} seconds. When nothing changes, checks back off to at most every {MAX_POLL_MS / 60_000} minutes; with no visible tab it checks about once a minute, and not at all while the app is closed. Background sync runs only while this app is running.</>}
      />
      {isDemo() && <div className="mb-4"><Banner title="Demo mode">Nothing syncs in demo mode.</Banner></div>}

      {center.length > 0 && (
        <div className="mb-5">
          <Panel title="Where your changes are" icon={RefreshCw} id="where">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              {quota && <p className="text-[12.5px] text-ink-3">GitHub request budget for your account: <span className="tnum font-medium text-ink-2">{quota.remaining}</span> of {quota.limit} left{quota.remaining < quota.limit * 0.1 ? <span className="text-waiting"> (low: syncing may pause until {formatInstant(quota.resetsAt, viewer.timezone)})</span> : `, resets ${formatInstant(quota.resetsAt, viewer.timezone)}`}. Source repositories and shared planning use the same budget.</p>}
              {center.map((c) => (
                <section key={c.id} aria-label={c.fullName} className="rounded-[10px] border border-line p-3">
                  <p className="font-medium"><Mono>{c.fullName}</Mono></p>
                  <ol className="mt-2 flex flex-col gap-1.5">
                    {c.facts.map((f) => (
                      <li key={f.key} className="flex items-start gap-2">
                        <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${f.tone === "ok" ? "bg-ok" : f.tone === "hold" ? "bg-blocked" : f.tone === "wait" ? "bg-waiting" : "bg-line-strong"}`} />
                        <div><p className="font-medium">{f.label}</p><p className="text-[12.5px] text-ink-3">{f.detail}</p></div>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-2 text-[12px] text-ink-3">{c.lastPolledAt ? `Last checked for teammates' changes ${formatInstant(c.lastPolledAt, viewer.timezone)}` : "Not checked yet"}{c.nextPollAt ? ` · next check ${formatInstant(c.nextPollAt, viewer.timezone)}` : ""}</p>
                </section>
              ))}
              <p className="text-[12px] text-ink-3">Syncs only while open. Nothing here means &ldquo;delivered to a teammate&rdquo;.</p>
            </div>
          </Panel>
        </div>
      )}

      <div className="mb-5"><Banner title={`Checks every ${poll} s while open; slower when idle.`} action={<Link href="/settings#polling-title" className="btn">Change interval</Link>} /></div>

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

      {conflicts.length > 0 && (
        <div className="mb-5">
          <Panel title={`Needs your decision (${conflicts.length})`} icon={ShieldCheck} id="conflicts">
            <ul>
              {conflicts.map((c) => {
                const fields = c.fields as string[];
                const local = c.local as Record<string, unknown>;
                const remote = c.remote as Record<string, unknown>;
                const base = (c.base ?? {}) as Record<string, unknown>;
                return (
                  <li key={c.id} className="flex flex-col gap-3 border-b border-line p-4 last:border-b-0">
                    <p className="text-[13px]"><span className="font-medium">{c.entityType}</span> in <Mono>{c.space.repoName}</Mono> was changed on this computer and by a teammate.</p>
                    <div className="table-wrap" tabIndex={0} role="region" aria-label={`Differences for ${c.entityType} in ${c.space.repoName}`}><table className="data !text-[12.5px] [overflow-wrap:anywhere]"><thead><tr><th scope="col">Field</th><th scope="col">Before either change</th><th scope="col">Your version</th><th scope="col">Teammate&apos;s version</th></tr></thead>
                      <tbody>{fields.map((f) => <tr key={f}><td className="mono">{f === "__deleted" ? "existence" : f}</td><td className="text-ink-3">{f === "__deleted" ? "existed" : val(base[f])}</td><td>{f === "__deleted" ? (Object.keys(local).length ? "kept / edited" : "deleted") : val(local[f])}</td><td>{f === "__deleted" ? (Object.keys(remote).length ? "kept / edited" : "deleted") : val(remote[f])}</td></tr>)}</tbody></table></div>
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={resolveConflictAction} submitLabel="Keep mine" submitAriaLabel={`Keep my version of ${c.entityType} in ${c.space.repoName}`} submitClassName="btn btn-primary" resetOnSuccess={false}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="choice" value="mine" /></ActionForm>
                      <ActionForm action={resolveConflictAction} submitLabel="Take theirs" submitAriaLabel={`Take the teammate\u2019s version of ${c.entityType} in ${c.space.repoName}`} submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="choice" value="theirs" /></ActionForm>
                    </div>
                    <p className="text-[12px] text-ink-3">Nothing is discarded until you choose.</p>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      )}

      <Panel title="Spaces" icon={RefreshCw} id="spaces">
        {states.length === 0 ? <EmptyState icon={RefreshCw} title="Nothing to sync yet" action={isHosted() ? undefined : <Link href="/team" className="btn btn-primary">Set up a team</Link>}>{isHosted() ? "Repository data is refreshed from GitHub in the background. Nothing else needs syncing." : "Everything stays on this computer. Create or join a team to share."}</EmptyState> : (
          <ul>
            {states.map(([s, st]) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 text-[13px] last:border-b-0">
                <div className="min-w-0"><Mono>{s.repoOwner}/{s.repoName}</Mono><p className="text-[12px] text-ink-3">{s.lastPolledAt ? <>checked <Time value={s.lastPolledAt} formatted={formatInstant(s.lastPolledAt, viewer.timezone)} /></> : "not checked yet"}{s.nextPollAt && <> · next about <Time value={s.nextPollAt} formatted={formatInstant(s.nextPollAt, viewer.timezone)} /></>}{s.lastError && s.lastError !== "offline" ? ` · ${s.lastError}` : ""}</p></div>
                <SyncBadge state={st.state} pending={st.pending} conflicts={st.conflicts} detail={st.detail} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {restores.length > 0 && (
        <div className="mt-5">
          <Panel title={`Server restored from a backup (${restores.length})`} icon={ShieldCheck} id="restored">
            <div className="flex flex-col text-[13px]">
              <p className="max-w-[75ch] text-pretty p-4 text-ink-3">The team server went back to an earlier copy, so some newer copies here were replaced. Unsent edits were kept.</p>
              <ul>
              {restores.map((r) => {
                const entries = r.detail as unknown as { type: string; entityId: string; deleted: boolean; data: Record<string, unknown>; resend: boolean }[];
                const sendable = entries.filter((e) => e.resend).length;
                return (
                  <li key={r.id} className="flex flex-col gap-2 border-t border-line p-4">
                    <span><strong className="tnum">{r.rolledBack}</strong> {r.rolledBack === 1 ? "item" : "items"} in <strong>{r.space.name}</strong> replaced by the server&apos;s older copy{r.kept > 0 ? <>, <strong className="tnum">{r.kept}</strong> with unsent edits kept</> : null}. Detected <Time value={r.at} formatted={formatInstant(r.at, viewer.timezone)} />.</span>
                    <ul className="text-[12.5px] text-ink-3" aria-label="What was replaced">
                      {entries.slice(0, 8).map((e) => <li key={`${e.type}/${e.entityId}`} className="break-words">{e.type} <Mono>{typeof e.data.title === "string" ? e.data.title : typeof e.data.name === "string" ? e.data.name : e.entityId}</Mono>{e.deleted ? " (you had deleted it)" : ""}</li>)}
                      {r.rolledBack > Math.min(entries.length, 8) && <li>and {r.rolledBack - Math.min(entries.length, 8)} more</li>}
                    </ul>
                    <span className="flex flex-wrap items-start gap-2">
                      {sendable > 0 && <ActionForm action={resendRestoredAction} submitLabel={`Send my copies again (${sendable})`} submitAriaLabel="Send my newer copies to the server again" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={r.id} /></ActionForm>}
                      <Sheet title="Keep the server's version?" description={`Your computer keeps what the server has. The ${r.rolledBack === 1 ? "replaced copy" : `${r.rolledBack} replaced copies`} will no longer be listed here, and you cannot send ${r.rolledBack === 1 ? "it" : "them"} again later.`} trigger={<button type="button" className="btn" aria-label="Keep the server's version and drop the replaced copies">Keep the server&apos;s version</button>}>
                        <ActionForm action={dismissRestoredAction} submitLabel="Keep the server's version" pendingLabel="Saving…" submitClassName="btn btn-primary" closeOnSuccess><input type="hidden" name="id" value={r.id} /></ActionForm>
                      </Sheet>
                    </span>
                    {sendable > 0 && <p className="max-w-[75ch] text-pretty text-[12px] text-ink-3">Sending again puts your {sendable === 1 ? "copy" : "copies"} back as new edits that teammates will see.</p>}
                  </li>
                );
              })}
              </ul>
            </div>
          </Panel>
        </div>
      )}

      {pendingOps.length > 0 && (
        <div className="mt-5"><Panel title={`Waiting to be sent (${pendingOps.length})`} icon={RefreshCw} id="outbox"><ul className="text-[12.5px]">{pendingOps.map((o) => <li key={o.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"><span><span className="font-medium">{o.kind === "DELETE" ? "Delete" : "Change"}</span> {o.entityType} in <Mono>{o.space.repoName}</Mono></span><span className="text-ink-3">{o.status.toLowerCase()}{o.error ? ` · ${o.error}` : ""}</span></li>)}</ul></Panel></div>
      )}

      {quarantined.length > 0 && (
        <div className="mt-5">
          <Panel title={`Edits set aside (${quarantined.length})`} icon={ShieldCheck} id="quarantine">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              <p className="text-ink-3">GitHub access to a space was removed, so these edits were not sent. Retry if access returns, or discard.</p>
              {[...new Set(quarantined.map((q) => q.spaceId))].map((spaceId) => {
                const sp = quarantined.find((q) => q.spaceId === spaceId)!.space;
                return (
                  <div key={spaceId} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-line p-3">
                    <span><Mono>{sp.repoName}</Mono> · {quarantined.filter((q) => q.spaceId === spaceId).length} edit(s)</span>
                    <span className="flex gap-2">
                      <ActionForm action={releaseQuarantineAction} submitLabel="Try sending again" submitAriaLabel={`Try sending the edits for ${sp.repoName} again`} submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="spaceId" value={spaceId} /><input type="hidden" name="action" value="retry" /></ActionForm>
                      <ActionForm action={releaseQuarantineAction} submitLabel="Discard" submitAriaLabel={`Discard the unsent edits for ${sp.repoName}`} submitClassName="btn text-blocked" resetOnSuccess={false}><input type="hidden" name="spaceId" value={spaceId} /><input type="hidden" name="action" value="discard" /></ActionForm>
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
