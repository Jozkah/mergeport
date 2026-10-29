import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { attentionFor } from "@/lib/services/request-cache";
import { planningWhere, type DerivedItem } from "@/lib/services/queries";
import { formatDuration, formatInstant } from "@/lib/format";
import { EmptyState, Mono, PageHeader, Panel, Segmented, StatusPill, Time, Avatar } from "@/components/ui/primitives";
import { BellRing, Hourglass } from "@/components/ui/icons";
import { itemHref } from "@/components/work/WorkTable";

export const metadata = { title: "My attention" };

const QUEUES = [
  { key: "needs-me", label: "Needs my review", help: "Pull requests where GitHub or a routing rule expects you to review." },
  { key: "team", label: "Needs team review", help: "Waiting on dashboard members or teams, including you if you are named." },
  { key: "waiting", label: "Waiting on others", help: "Waiting on an external reviewer, such as a maintainer who is not a dashboard member. Work elsewhere can continue." },
  { key: "changes", label: "Changes requested", help: "Your pull requests where a reviewer asked for changes." },
  { key: "blocked", label: "Blocked", help: "Failing checks, merge conflicts or unfinished dependencies." },
] as const;

const QUEUE_STATUS: Record<string, string> = { "needs-me": "NEEDS_MY_REVIEW", team: "WAITING_TEAM", waiting: "WAITING_EXTERNAL", changes: "CHANGES_REQUESTED", blocked: "BLOCKED" };

/** One compact line of facts; the evidence (who, since when, which rule) sits behind "Why". */
function Row({ d, tz, now, queue }: { d: DerivedItem; tz: string; now: Date; queue: string }) {
  const x = d.derivation;
  const pending = x.actors.filter((a) => a.status === "PENDING" || a.status === "UNAVAILABLE" || a.status === "APPROVED_STALE" || a.status === "CHANGES_REQUESTED");
  const first = pending[0];
  const showStatus = x.primary !== QUEUE_STATUS[queue]; // the queue already says it; only a different state is news
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={itemHref(d.item)} className="min-w-0 text-[13.5px] font-medium leading-snug underline-offset-2 hover:underline [overflow-wrap:anywhere]">{d.item.title}</Link>
        <div className="flex shrink-0 items-center gap-2">
          {showStatus && <StatusPill status={x.primary} />}
          {x.waiting && <span className="tnum whitespace-nowrap text-[12px] text-ink-3" title={`since ${x.waiting.since.toISOString()}`}>{formatDuration(x.waiting.elapsedMs)}</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <Mono title={d.item.repository.fullName}>#{d.item.number}</Mono>
        <span className="inline-flex items-center gap-1"><Avatar login={d.item.authorLogin ?? "?"} size={14} />{d.item.authorLogin ?? "unknown"}</span>
        {first && <span className="inline-flex items-center gap-1 text-ink-2"><Hourglass size={12} aria-hidden />{queue === "changes" ? "Changes asked by" : "Waiting on"} <Avatar login={first.actor.ref} size={14} /><span className="font-medium">{first.actor.display ?? first.actor.ref}</span>{pending.length > 1 && <span className="text-ink-3">+{pending.length - 1}</span>}</span>}
        {d.ruleConflict && <span className="text-waiting">Rule conflict</span>}
      </div>
      <details className="group text-[12px] text-ink-3">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 hover:text-ink-2 [&::-webkit-details-marker]:hidden"><span className="underline decoration-dotted underline-offset-2">Why</span></summary>
        <div className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
          {pending.map((a) => (
            <p key={a.actor.kind + a.actor.ref}><span className="font-medium text-ink-2">{a.actor.display ?? a.actor.ref}</span> ({a.external ? "external" : "team"}, {a.status.replace("_", " ").toLowerCase()}): {a.evidence}{a.since && <> · since <Time value={a.since} formatted={formatInstant(a.since, tz)} />{a.sinceBasis === "ready" ? " (became reviewable)" : " (request first seen)"}</>}</p>
          ))}
          {x.explanation.map((e) => <p key={e}>{e}</p>)}
          {d.ruleConflict && <p className="text-waiting">Rule conflict: {d.ruleConflict}</p>}
          <p>Data synchronized {formatDuration(now.getTime() - d.item.syncedAt.getTime())} ago.</p>
        </div>
      </details>
    </li>
  );
}

/** Rows grouped under their repository, so a long queue reads as a few short lists instead of one wall. */
function Grouped({ rows, tz, now, queue }: { rows: DerivedItem[]; tz: string; now: Date; queue: string }) {
  const groups = new Map<string, DerivedItem[]>();
  for (const d of rows) (groups.get(d.item.repository.fullName) ?? groups.set(d.item.repository.fullName, []).get(d.item.repository.fullName)!).push(d);
  return (
    <div className="scroll-region">
      {[...groups].map(([repo, items]) => (
        <section key={repo} aria-label={repo}>
          <h3 className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-[12px] font-medium text-ink-2"><Mono>{repo}</Mono><span className="tnum rounded-full bg-muted px-1.5 text-[11px] text-ink-3">{items.length}</span></h3>
          <ul className="fit-list" style={{ "--fit-min": "520px" } as React.CSSProperties}>{items.map((d) => <Row key={d.item.id} d={d} tz={tz} now={now} queue={queue} />)}</ul>
        </section>
      ))}
    </div>
  );
}

export default async function Attention({ searchParams }: { searchParams: Promise<{ queue?: string }> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const now = new Date();
  const q = await attentionFor(viewer);
  const lists = { "needs-me": q.needsMyReview, team: q.needsTeamReview, waiting: q.waitingExternal, changes: q.changesRequested, blocked: q.blocked } as const;
  const active = (QUEUES.find((x) => x.key === sp.queue)?.key ?? "needs-me") as keyof typeof lists;
  const meta = QUEUES.find((x) => x.key === active)!;
  const rows = lists[active];

  const manualPlanning = await db.waitingRecord.findMany({
    where: { status: "PENDING", source: "MANUAL", planningItemId: { not: null }, planningItem: await planningWhere(db, viewer) },
    include: { planningItem: { include: { project: { select: { name: true } } } } },
    orderBy: { startedAt: "asc" },
  });

  return (
    <>
      <PageHeader title="My attention" subtitle="Review waiting is tracked separately from open or closed state. Each item says who is expected to act, why, and since when." />
      <div className="mb-4"><Segmented label="Queues" items={QUEUES.map((x) => ({ href: `/attention?queue=${x.key}`, label: x.label, active: x.key === active, count: lists[x.key].length }))} /></div>
      <Panel title={meta.label} icon={BellRing} id="queue">
        <p className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">{meta.help}</p>
        {rows.length === 0 ? <EmptyState icon={BellRing} title="Nothing here">This queue is empty for the repositories you can see.</EmptyState> : <Grouped rows={rows} tz={viewer.timezone} now={now} queue={active} />}
      </Panel>

      {(q.manualWaiting.length > 0 || manualPlanning.length > 0) && (
        <div className="mt-5">
          <Panel title="Manual waiting records" icon={Hourglass} id="manual">
            <ul>
              {q.manualWaiting.flatMap((d) => d.manualWaiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4 text-[13px] last:border-b-0">
                  <div className="min-w-0"><Link href={itemHref(d.item)} className="font-medium hover:underline">{d.item.title}</Link><p className="text-[12px] text-ink-3">{w.reason}</p></div>
                  <div className="flex items-center gap-2 text-[12.5px]"><Avatar login={w.reviewerRef} size={18} />{w.reviewerRef}<span className="tnum text-ink-3">{formatDuration(now.getTime() - w.startedAt.getTime())}</span></div>
                </li>
              )))}
              {manualPlanning.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4 text-[13px] last:border-b-0">
                  <div className="min-w-0"><Link href="/planning" className="font-medium hover:underline">{w.planningItem!.title}</Link><p className="text-[12px] text-ink-3">{w.planningItem!.project.name} · {w.reason}</p></div>
                  <div className="flex items-center gap-2 text-[12.5px]"><Avatar login={w.reviewerRef} size={18} />{w.reviewerRef}<span className="tnum text-ink-3">{formatDuration(now.getTime() - w.startedAt.getTime())}</span></div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}
