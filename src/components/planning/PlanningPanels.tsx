import Link from "next/link";
import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { BOARD_TEMPLATES, GROUPINGS } from "@/lib/domain/boards";
import { formatDateOnly, formatDuration, formatInstant } from "@/lib/format";
import { applySuggestionAction, assignEpicAction, assignIterationAction, automationAction, closeIterationAction, createBoardAction, createEpicAction, createIterationAction, deleteBoardAction, epicStatusAction, linkAction, shipAction, updateBoardAction } from "@/app/planning-actions";
import { listBoards, listEpics, releaseReadiness, suggestedMoves } from "@/lib/services/planning-ext";
import { dependencyGraph, deliveryAnalytics } from "@/lib/services/planning-insight";
import type { CardView } from "@/lib/services/planning-view";
import { ActionForm } from "@/components/forms/ActionForm";
import { EmptyState, Panel } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Sheet } from "@/components/ui/dialog";
import { CalendarDays, Flag, Kanban, ListChecks, Milestone, Route, Settings } from "@/components/ui/icons";
import { StatusMark } from "@/components/ui/StatusMark";

type Common = { db: Db; viewer: Viewer; projectId: string };

/** Create, edit and delete named boards. A board only chooses columns, labels and limits: it never copies cards. */
export async function BoardsManager({ db, viewer, projectId, columns }: Common & { columns: { key: string; name: string }[] }) {
  const boards = await listBoards(db, viewer, projectId);
  return (
    <Panel title="Boards" icon={Settings} id="boards">
      <div className="flex flex-col gap-4 p-4 text-[13px]">
        {boards.length === 0 && <p className="text-ink-3">The default board shows every column. Add a named board to focus on part of the flow, rename columns, and set work-in-progress limits. Limits are advice: a column over its limit is flagged, nothing is blocked.</p>}
        {boards.map((b) => (
          <details key={b.id} className="rounded-[10px] border border-line p-3">
            <summary className="cursor-pointer font-medium">{b.name} <span className="font-normal text-ink-3">· {(b.columns as { key: string }[]).length} columns · {b.groupBy === "none" ? "no lanes" : `lanes by ${b.groupBy}`} · {b.density}</span></summary>
            <ActionForm action={updateBoardAction} submitLabel="Save board" className="mt-3" resetOnSuccess={false}>
              <input type="hidden" name="id" value={b.id} />
              <div className="grid gap-3 md:grid-cols-3">
                <div><label className="label" htmlFor={`bn-${b.id}`}>Name</label><input id={`bn-${b.id}`} name="name" className="input" defaultValue={b.name} required /></div>
                <div><label className="label" htmlFor={`bg-${b.id}`}>Lanes</label><Select id={`bg-${b.id}`} name="groupBy" className="select" defaultValue={b.groupBy}>{GROUPINGS.map((g) => <option key={g} value={g}>{g === "none" ? "No lanes" : `By ${g}`}</option>)}</Select></div>
                <div><label className="label" htmlFor={`bd-${b.id}`}>Density</label><Select id={`bd-${b.id}`} name="density" className="select" defaultValue={b.density}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></Select></div>
              </div>
              <label className="label mt-3" htmlFor={`bc-${b.id}`}>Columns, in order. One per line: key | label | limit</label>
              <textarea id={`bc-${b.id}`} name="columns" className="textarea min-h-28 font-mono text-[12.5px]" defaultValue={(b.columns as { key: string; name?: string; wip?: number | null }[]).map((c) => [c.key, c.name ?? "", c.wip ?? ""].join(" | ")).join("\n")} spellCheck={false} />
              <p className="mt-1 text-[12px] text-ink-3">Available columns: {columns.map((c) => c.key).join(", ")}</p>
            </ActionForm>
            <ActionForm action={deleteBoardAction} submitLabel="Delete board" submitClassName="btn btn-danger" className="mt-2"><input type="hidden" name="id" value={b.id} /></ActionForm>
          </details>
        ))}
        <ActionForm action={createBoardAction} submitLabel="Add board" className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]" submitClassName="btn btn-primary">
          <input type="hidden" name="projectId" value={projectId} />
          <div><label className="label" htmlFor="nb-tpl">Start from</label><Select id="nb-tpl" name="template" className="select" defaultValue="delivery">{BOARD_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}: {t.description}</option>)}</Select></div>
          <div><label className="label" htmlFor="nb-name">Name (optional)</label><input id="nb-name" name="name" className="input" placeholder="Same as the template" /></div>
        </ActionForm>
      </div>
    </Panel>
  );
}

/** What the project's automation policy would do, as a preview. Nothing moves until someone applies it, and only the local board changes. */
export async function SuggestionsPanel({ db, viewer, projectId, automation }: Common & { automation: string }) {
  const s = await suggestedMoves(db, viewer, projectId);
  return (
    <Panel title="Suggested moves" icon={Flag} id="suggestions">
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        {viewer.isAdmin && (
          <ActionForm action={automationAction} submitLabel="Save" submitClassName="btn" className="flex flex-wrap items-end gap-3" resetOnSuccess={false}>
            <input type="hidden" name="projectId" value={projectId} />
            <div><label className="label" htmlFor="au-mode">When a pull request is merged or an issue is closed</label><Select id="au-mode" name="mode" className="select" defaultValue={automation}><option value="off">Do nothing</option><option value="suggest">Suggest moving its card to Done</option></Select></div>
          </ActionForm>
        )}
        {automation !== "suggest" ? <p className="text-ink-3">Suggestions are off for this project.</p> : s.length === 0 ? <p className="text-ink-3">Nothing to suggest right now.</p> : (
          <ul className="divide-y divide-line">
            {s.map((x) => (
              <li key={x.itemId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div><p className="font-medium">{x.title}</p><p className="text-[12px] text-ink-3">{x.why}. Preview: {x.from} → Done on the board. GitHub is not changed.</p></div>
                <ActionForm action={applySuggestionAction} submitLabel="Move to Done" submitClassName="btn"><input type="hidden" name="itemId" value={x.itemId} /></ActionForm>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export async function EpicsView({ db, viewer, projectId, cards }: Common & { cards: CardView[] }) {
  const epics = await listEpics(db, viewer, projectId);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Epics" icon={Flag} id="epics" actions={
        <Sheet title="New epic" description="A feature that spans several tasks and issues. One level only." trigger={<button className="btn btn-primary">New epic</button>}>
          <ActionForm action={createEpicAction} submitLabel="Create epic">
            <input type="hidden" name="projectId" value={projectId} />
            <div className="flex flex-col gap-3">
              <div><label className="label" htmlFor="ep-title">Title</label><input id="ep-title" name="title" className="input" required /></div>
              <div><label className="label" htmlFor="ep-desc">Description</label><textarea id="ep-desc" name="description" className="textarea min-h-20" /></div>
              <div className="grid grid-cols-3 gap-3">
                <div><label className="label" htmlFor="ep-owner">Owner</label><input id="ep-owner" name="owner" className="input" placeholder="login" /></div>
                <div><label className="label" htmlFor="ep-start">Start</label><input id="ep-start" name="start" type="date" className="input" /></div>
                <div><label className="label" htmlFor="ep-target">Target</label><input id="ep-target" name="target" type="date" className="input" /></div>
              </div>
              <div><label className="label" htmlFor="ep-dec">Decisions so far</label><textarea id="ep-dec" name="decisions" className="textarea min-h-16" /></div>
            </div>
          </ActionForm>
        </Sheet>
      }>
        {epics.length === 0 ? <EmptyState icon={Flag} title="No epics yet">Group related cards under an epic to see their progress together.</EmptyState> : (
          <ul className="divide-y divide-line">
            {epics.map((e) => (
              <li key={e.id} className="flex flex-col gap-1.5 p-4 text-[13px]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{e.title} {e.status === "DONE" && <span className="font-normal text-ok">· done</span>}</p>
                  <p className="tnum text-[12px] text-ink-3">{e.ownerLogin ? `@${e.ownerLogin} · ` : ""}{e.startDate ? formatDateOnly(e.startDate) : "no start"} → {e.targetDate ? formatDateOnly(e.targetDate) : "no target"}</p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${e.title} progress`} aria-valuemin={0} aria-valuemax={Math.max(1, e.total)} aria-valuenow={e.done}><div className="h-full bg-ok" style={{ width: `${e.total ? Math.round((e.done / e.total) * 100) : 0}%` }} /></div>
                <p className="tnum text-[12px] text-ink-3">{e.done} of {e.total} visible cards done{e.hidden > 0 ? ` · ${e.hidden} more you cannot see` : ""}</p>
                {e.description && <p className="text-ink-2">{e.description}</p>}
                {e.decisions && <p className="text-[12.5px] text-ink-3">Decisions: {e.decisions}</p>}
                <div className="flex gap-2">
                  <ActionForm action={epicStatusAction} submitLabel={e.status === "DONE" ? "Reopen" : "Mark done"} submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="status" value={e.status === "DONE" ? "OPEN" : "DONE"} /></ActionForm>
                  <ActionForm action={epicStatusAction} submitLabel="Delete epic" submitClassName="btn btn-danger"><input type="hidden" name="id" value={e.id} /><input type="hidden" name="delete" value="1" /></ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {epics.length > 0 && cards.length > 0 && (
        <Panel title="Put a card in an epic" icon={ListChecks} id="epic-assign">
          <ActionForm action={assignEpicAction} submitLabel="Save" className="grid max-w-[640px] gap-3 p-4 sm:grid-cols-2" submitClassName="btn" resetOnSuccess={false}>
            <div><label className="label" htmlFor="ea-card">Card</label><Select id="ea-card" name="itemId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 70)}{c.epicTitle ? ` (in ${c.epicTitle})` : ""}</option>)}</Select></div>
            <div><label className="label" htmlFor="ea-epic">Epic</label><Select id="ea-epic" name="epicId" className="select" defaultValue=""><option value="">None (remove from its epic)</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</Select></div>
          </ActionForm>
        </Panel>
      )}
    </div>
  );
}

export async function IterationsView({ db, projectId, cards }: { db: Db; projectId: string; cards: CardView[] }) {
  const iterations = await db.iteration.findMany({ where: { projectId }, orderBy: { startDate: "asc" } });
  const open = iterations.filter((i) => !i.closedAt);
  const byIter = (id: string) => cards.filter((c) => c.iterationId === id);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Iterations" icon={CalendarDays} id="iterations" actions={
        <Sheet title="New iteration" description="A short timebox. A milestone is the delivery goal; an iteration is the cycle currently funding part of it." trigger={<button className="btn btn-primary">New iteration</button>}>
          <ActionForm action={createIterationAction} submitLabel="Create iteration">
            <input type="hidden" name="projectId" value={projectId} />
            <div className="flex flex-col gap-3">
              <div><label className="label" htmlFor="it-name">Name</label><input id="it-name" name="name" className="input" required placeholder="Week 45" /></div>
              <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="it-start">Starts</label><input id="it-start" name="start" type="date" className="input" required /></div><div><label className="label" htmlFor="it-end">Ends</label><input id="it-end" name="end" type="date" className="input" required /></div></div>
            </div>
          </ActionForm>
        </Sheet>
      }>
        {iterations.length === 0 ? <EmptyState icon={CalendarDays} title="No iterations yet">Plan short cycles separately from milestones.</EmptyState> : (
          <ul className="divide-y divide-line">
            {iterations.map((i) => {
              const mine = byIter(i.id);
              const done = mine.filter((c) => c.columnKey === "done").length;
              return (
                <li key={i.id} className="flex flex-col gap-1.5 p-4 text-[13px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{i.name} {i.closedAt && <span className="font-normal text-ink-3">· closed</span>}</p><p className="tnum text-[12px] text-ink-3">{formatDateOnly(i.startDate)} → {formatDateOnly(i.endDate)}</p></div>
                  <p className="tnum text-[12px] text-ink-3">{done} of {mine.length} cards done</p>
                  {!i.closedAt && (
                    <ActionForm action={closeIterationAction} submitLabel="Close iteration" submitClassName="btn" className="flex flex-wrap items-end gap-3" resetOnSuccess={false}>
                      <input type="hidden" name="id" value={i.id} />
                      <div><label className="label" htmlFor={`cl-${i.id}`}>Unfinished cards go to</label><Select id={`cl-${i.id}`} name="carryTo" className="select" defaultValue=""><option value="">No iteration</option>{open.filter((o) => o.id !== i.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></div>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {open.length > 0 && cards.length > 0 && (
        <Panel title="Put a card in an iteration" icon={ListChecks} id="iter-assign">
          <ActionForm action={assignIterationAction} submitLabel="Save" className="grid max-w-[640px] gap-3 p-4 sm:grid-cols-2" submitClassName="btn" resetOnSuccess={false}>
            <div><label className="label" htmlFor="ia-card">Card</label><Select id="ia-card" name="itemId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 70)}</option>)}</Select></div>
            <div><label className="label" htmlFor="ia-iter">Iteration</label><Select id="ia-iter" name="iterationId" className="select" defaultValue=""><option value="">None</option>{open.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></div>
          </ActionForm>
        </Panel>
      )}
    </div>
  );
}

export async function ReleaseView({ db, viewer, projectId }: Common) {
  const milestones = await db.dashboardMilestone.findMany({ where: { workspaceId: viewer.workspaceId, OR: [{ projectId }, { projectId: null }] }, orderBy: { targetDate: "asc" } });
  const reads = await Promise.all(milestones.map((m) => releaseReadiness(db, viewer, m.id)));
  return (
    <div className="flex flex-col gap-5">
      {reads.length === 0 && <Panel title="Release readiness" icon={Milestone} id="release"><EmptyState icon={Milestone} title="No milestones">An administrator can create a dashboard milestone to track a release.</EmptyState></Panel>}
      {reads.map((r) => (
        <Panel key={r.milestone.id} title={r.milestone.name} icon={Milestone} id={`rel-${r.milestone.id}`}>
          <div className="flex flex-col gap-3 p-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5"><StatusMark status={r.workFinished ? "done" : "pending"} size={16} ariaLabel={r.workFinished ? "Work finished" : "Work not finished"} />Work {r.workFinished ? "finished" : "not finished"}</span>
              <span className="inline-flex items-center gap-1.5"><StatusMark status={r.shipped ? "done" : "pending"} size={16} ariaLabel={r.shipped ? "Release shipped" : "Release not shipped"} />Release {r.shipped ? `shipped${r.milestone.releaseTag ? ` as ${r.milestone.releaseTag}` : ""}` : "not shipped"}</span>
              {r.milestone.targetDate && <span className="tnum text-ink-3">Target {formatDateOnly(r.milestone.targetDate)}</span>}
              {r.milestone.releaseUrl && <a className="link" href={r.milestone.releaseUrl} target="_blank" rel="noopener noreferrer">Release on GitHub</a>}
            </div>
            <p className="text-[12px] text-ink-3">{r.total - r.hidden} visible card{r.total - r.hidden === 1 ? "" : "s"}{r.hidden > 0 ? ` and ${r.hidden} you cannot see` : ""}. Finishing the work does not mark a release as shipped.</p>
            {[
              { title: "Not finished", rows: r.unfinished.map((x) => ({ id: x.id, text: `${x.title} (${x.column})` })) },
              { title: "Failing checks", rows: r.failingChecks.map((x) => ({ id: x.id, text: x.title })) },
              { title: "Blocked by unfinished dependencies", rows: r.blocked.map((x) => ({ id: x.id, text: `${x.title}: ${x.blockers} blocker${x.blockers === 1 ? "" : "s"}` })) },
              { title: "Waiting on a decision", rows: r.pendingDecisions.map((x) => ({ id: x.id, text: `${x.title}: ${x.waitingOn}` })) },
            ].map((g) => g.rows.length > 0 && (
              <div key={g.title}><p className="label">{g.title} ({g.rows.length})</p><ul className="flex flex-col gap-0.5">{g.rows.map((x) => <li key={x.id}><Link className="link" href={`/tasks/${x.id}`}>{x.text}</Link></li>)}</ul></div>
            ))}
            {viewer.isAdmin && (
              <ActionForm action={shipAction} submitLabel={r.shipped ? "Mark as not shipped" : "Mark as shipped"} submitClassName="btn" className="flex flex-wrap items-end gap-3" resetOnSuccess={false}>
                <input type="hidden" name="id" value={r.milestone.id} /><input type="hidden" name="shipped" value={r.shipped ? "0" : "1"} />
                {!r.shipped && (<><div><label className="label" htmlFor={`rt-${r.milestone.id}`}>Release tag</label><input id={`rt-${r.milestone.id}`} name="tag" className="input" placeholder="v1.4.0" /></div><div><label className="label" htmlFor={`ru-${r.milestone.id}`}>Release link (https)</label><input id={`ru-${r.milestone.id}`} name="url" className="input" placeholder="https://github.com/…" /></div></>)}
              </ActionForm>
            )}
          </div>
        </Panel>
      ))}
    </div>
  );
}

const NODE_W = 190;
const NODE_H = 40;
const GAP_X = 70;
const GAP_Y = 16;

export async function MapView({ db, viewer, projectId, cards }: Common & { cards: CardView[] }) {
  const g = await dependencyGraph(db, viewer, {});
  const byLayer = new Map<number, typeof g.nodes>();
  for (const n of g.nodes) (byLayer.get(n.layer) ?? byLayer.set(n.layer, []).get(n.layer)!).push(n);
  const pos = new Map<string, { x: number; y: number }>();
  let height = 0;
  for (const [layer, list] of [...byLayer].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => b.holdsBack - a.holdsBack || a.title.localeCompare(b.title)).forEach((n, i) => pos.set(n.id, { x: layer * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) }));
    height = Math.max(height, list.length * (NODE_H + GAP_Y));
  }
  const width = (Math.max(0, ...byLayer.keys()) + 1) * (NODE_W + GAP_X);
  const opaqueBy = new Map<string, number>();
  for (const o of g.opaque) opaqueBy.set(o.visibleEnd, (opaqueBy.get(o.visibleEnd) ?? 0) + 1);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Dependency map" icon={Route} id="map">
        {g.nodes.length === 0 ? <EmptyState icon={Route} title="No links yet">Link cards below. Links can cross projects that are shared with the same audience.</EmptyState> : (
          <div className="p-4">
            {g.critical.length > 0 && (
              <p className="mb-3 text-[12.5px] text-ink-2">Critical blockers: {g.critical.map((c) => `${c.title} (holds back ${c.holdsBack})`).join(" · ")}</p>
            )}
            <div className="overflow-auto rounded-[10px] border border-line bg-canvas p-3">
              <svg role="img" aria-label="Dependency map: each box is a card, an arrow points from a blocker to the card it blocks" width={width} height={Math.max(height, 40)} className="block">
                <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--color-ink-3)" /></marker></defs>
                {g.edges.map((e, i) => {
                  const a = pos.get(e.from);
                  const b = pos.get(e.to);
                  if (!a || !b) return null;
                  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
                  return <path key={i} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={e.kind === "blocks" ? "var(--color-ink-3)" : "var(--color-line-strong)"} strokeWidth={1.5} strokeDasharray={e.kind === "blocks" ? undefined : "4 3"} markerEnd={e.kind === "blocks" ? "url(#arr)" : undefined}><title>{e.kind}</title></path>;
                })}
                {g.nodes.map((n) => {
                  const p = pos.get(n.id)!;
                  return (
                    <a key={n.id} href={`/tasks/${n.id}`}>
                      <g transform={`translate(${p.x},${p.y})`}>
                        <rect width={NODE_W} height={NODE_H} rx={8} fill="var(--color-surface)" stroke={n.holdsBack > 0 ? "var(--color-blocked)" : "var(--color-line-strong)"} strokeWidth={n.holdsBack > 0 ? 1.6 : 1} />
                        <text x={10} y={17} fontSize={12} fill="var(--color-ink)" textDecoration={n.finished ? "line-through" : undefined}>{n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title}</text>
                        <text x={10} y={32} fontSize={10.5} fill="var(--color-ink-3)">{n.projectName} · {n.column}{opaqueBy.get(n.id) ? ` · +${opaqueBy.get(n.id)} hidden` : ""}</text>
                      </g>
                    </a>
                  );
                })}
              </svg>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">Solid arrows block. Dashed lines are related or duplicate links. A link to a card you cannot see shows only as “+N hidden” on the card you can see.</p>
          </div>
        )}
      </Panel>
      {cards.length > 1 && (
        <Panel title="Link two cards" icon={ListChecks} id="link">
          <ActionForm action={linkAction} submitLabel="Add link" className="grid max-w-[760px] gap-3 p-4 sm:grid-cols-3" submitClassName="btn">
            <div><label className="label" htmlFor="lk-a">This card</label><Select id="lk-a" name="fromId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 60)}</option>)}</Select></div>
            <div><label className="label" htmlFor="lk-k">…</label><Select id="lk-k" name="kind" className="select" defaultValue="blocks"><option value="blocks">blocks</option><option value="related">is related to</option><option value="duplicates">duplicates</option></Select></div>
            <div><label className="label" htmlFor="lk-b">This card</label><Select id="lk-b" name="toId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 60)}</option>)}</Select></div>
          </ActionForm>
          <p className="px-4 pb-4 text-[12px] text-ink-3">Cycles are rejected. A card blocked by a pull request that was closed without merging stays blocked.</p>
        </Panel>
      )}
      <span hidden>{projectId}</span>
    </div>
  );
}

const days = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));

export async function InsightsView({ db, viewer, projectId }: Common) {
  const a = await deliveryAnalytics(db, viewer, projectId);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Delivery analytics" icon={Kanban} id="insights">
        <div className="flex flex-col gap-4 p-4 text-[13px]">
          {a.recordingSince === null ? (
            <p className="text-ink-2">Mergeport has not recorded any planning history for this project yet. From now on every card created or moved is recorded, and these numbers appear as history builds up. Nothing is estimated from today&rsquo;s state.</p>
          ) : (
            <p className="text-ink-3">Recording since {formatInstant(a.recordingSince, viewer.timezone)} ({a.events} event{a.events === 1 ? "" : "s"}). Numbers cover only work whose start and finish were recorded.</p>
          )}
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-[10px] border border-line p-3"><dt className="text-ink-3">Cycle time (median)</dt><dd className="mt-1 text-[18px] font-medium tnum">{days(a.cycle.medianMs)}</dd><dd className="text-[12px] text-ink-3">{a.cycle.count} finished card{a.cycle.count === 1 ? "" : "s"}{a.cycle.skipped ? ` · ${a.cycle.skipped} left out (start not recorded)` : ""}{a.cycle.p85Ms ? ` · 85% within ${days(a.cycle.p85Ms)}` : ""}</dd></div>
            <div className="rounded-[10px] border border-line p-3"><dt className="text-ink-3">Review wait (median)</dt><dd className="mt-1 text-[18px] font-medium tnum">{days(a.reviewWait.medianMs)}</dd><dd className="text-[12px] text-ink-3">{a.reviewWait.count} review{a.reviewWait.count === 1 ? "" : "s"} · from when Mergeport first saw the request to the first review</dd></div>
            <div className="rounded-[10px] border border-line p-3"><dt className="text-ink-3">Aging work in progress</dt><dd className="mt-1 text-[18px] font-medium tnum">{a.aging.length}</dd><dd className="text-[12px] text-ink-3">{a.agingUnrecorded ? `${a.agingUnrecorded} more not measurable yet` : "all measured"}</dd></div>
          </dl>
          {a.aging.length > 0 && <div><p className="label">Longest in their column</p><ul className="flex flex-col gap-0.5">{a.aging.slice(0, 5).map((x) => <li key={x.itemId}><Link className="link" href={`/tasks/${x.itemId}`}>{x.columnKey}</Link> <span className="text-ink-3 tnum">{days(x.sinceMs)}</span></li>)}</ul></div>}
          {a.scope.length > 0 && <div><p className="label">Scope added after a milestone started</p><ul>{a.scope.map((s) => <li key={s.milestoneId}>{s.name}: {s.added} added later, {s.atStart} there from the start</li>)}</ul></div>}
        </div>
      </Panel>
    </div>
  );
}
