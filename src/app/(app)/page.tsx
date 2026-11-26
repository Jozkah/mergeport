import { AiShortcuts } from "@/components/ai/AiShortcuts";
import { AiTool } from "@/components/ai/AiTool";
import { aiEnabled } from "@/lib/services/ai";
import { readScope, scopeKey } from "@/lib/scope";
import Link from "next/link";
import { cookies } from "next/headers";
import { isHosted } from "@/lib/public-url";
import { requireViewer } from "@/lib/authz-page";
import { db } from "@/lib/db";
import { attentionFor } from "@/lib/services/request-cache";
import { openedPerDay, overview, recentActivity, visibleForkMappings } from "@/lib/services/queries";
import { milestoneProgress } from "@/lib/services/planning";
import { projectWhere, repoWhere } from "@/lib/authz/viewer";
import { formatDateOnly, formatDuration, formatInstant } from "@/lib/format";
import { Avatar, EmptyState, Mono, Panel, StatusPill, Time } from "@/components/ui/primitives";
import { Activity, ArrowRight, BellRing, GitFork, Hourglass, Milestone, Newspaper, CircleAlert } from "@/components/ui/icons";
import { itemHref } from "@/components/work/WorkTable";
import { OpenedChart } from "@/components/work/OpenedChart";
import { Metric as AnimatedNumber } from "@/components/ui/Metric";
import { todayIn } from "@/lib/domain/planning";
import { GettingStarted } from "@/components/onboarding/GettingStarted";
import { gettingStarted } from "@/lib/services/getting-started";
import { latestDigest } from "@/lib/services/digest";
import { listTasks } from "@/lib/services/tasks";
import { ListChecks } from "@/components/ui/icons";

const PRIORITY_WORD: Record<number, string> = { 4: "Urgent", 3: "High", 2: "Normal", 1: "Low" };

/** The viewer's next written tasks: assigned to them, open, not blocked, not waiting on an unfinished task; urgent first, then each project's order. */
async function nextTasks(viewer: Awaited<ReturnType<typeof requireViewer>>["viewer"]) {
  const mine = (await listTasks(db, viewer, { scope: "mine", status: "open" })).filter((t) => {
    const labels = Array.isArray(t.labels) ? (t.labels as string[]) : [];
    return !t.workItemId && t.workRepoGithubId === null && t.column.key !== "blocked" && !labels.includes("reference") && !labels.includes("archived");
  });
  const waiting = new Set(
    (await db.planningLink.findMany({ where: { kind: "blocks", toId: { in: mine.map((t) => t.id) }, from: { column: { key: { not: "done" } } } }, select: { toId: true } })).map((l) => l.toId),
  );
  const ready = mine.filter((t) => !waiting.has(t.id));
  return { total: ready.length, urgent: ready.filter((t) => t.priority === 4).length, top: ready.slice(0, 8) };
}

export const metadata = { title: "Overview" };

function Metric({ href, title, icon: I, value, note, tone }: { href: string; title: string; icon: typeof BellRing; value: number; note: string; tone: "needs" | "waiting" | "blocked" }) {
  return (
    <Link href={href} className="panel spot-card flex h-full flex-col transition-shadow duration-[var(--duration-feedback)] hover:shadow-hair focus-visible:shadow-hair">
      <div className="panel-head !min-h-9"><span className="flex items-center gap-2 text-[14px] font-medium text-ink-2"><I size={16} aria-hidden className="text-ink-3" />{title}</span><ArrowRight size={14} aria-hidden className="text-ink-3" /></div>
      <div className="panel-body flex-1 px-4 py-4"><p className={`text-[32px] font-medium leading-9 ${value > 0 ? (tone === "needs" ? "text-needs" : tone === "waiting" ? "text-waiting" : "text-blocked") : "text-ink-3"}`}><AnimatedNumber value={value} /></p><p className="mt-1 text-[12.5px] text-ink-3">{note}</p></div>
    </Link>
  );
}

export default async function Overview() {
  const { viewer, user } = await requireViewer();
  const now = new Date();
  const [o, q, days, activity, forks, milestones] = await Promise.all([
    overview(db, viewer, now),
    attentionFor(viewer, scopeKey(await readScope(db, viewer))),
    openedPerDay(db, viewer, 14, now),
    recentActivity(db, viewer, 5),
    visibleForkMappings(db, viewer),
    db.dashboardMilestone.findMany({ where: { workspaceId: viewer.workspaceId, status: "OPEN", targetDate: { gte: new Date(todayIn(viewer.timezone, now) + "T00:00:00Z") }, OR: [{ projectId: null }, { project: projectWhere(viewer) }] }, orderBy: { targetDate: "asc" }, take: 1 }),
  ]);
  const ms = milestones[0] ? await milestoneProgress(db, viewer, milestones[0].id) : null;
  const behind = forks.filter((m) => (m.comparisons[0]?.behindBy ?? 0) > 0);
  const repoCount = await db.repository.count({ where: repoWhere(viewer) });
  const none = o.openIssues + o.openPrs === 0 && q.needsMyReview.length === 0;
  const steps = await gettingStarted(db, viewer);
  const digest = await latestDigest(db, viewer, now);
  const next = await nextTasks(viewer);

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[24px] font-medium leading-8 tracking-[-0.01em]">Hello, {user.name?.split(" ")[0] ?? user.login}</h1>
        <p className="mt-1 text-[13px] text-ink-3">What needs you, and what is waiting on someone else, across the repositories you can see.</p>
      </div>

      <AiShortcuts show={await aiEnabled(db, viewer.workspaceId)}>
        <AiTool tool="focus" label="What should I do first?" />
      </AiShortcuts>

      <GettingStarted steps={steps} dismissed={(await cookies()).get("mp-gs")?.value === "1"} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric href="/attention?queue=needs-me" title="Needs my review" icon={BellRing} value={o.needsMyReview} note="Pull requests expecting you" tone="needs" />
        <Metric href="/attention?queue=waiting" title="Waiting on others" icon={Hourglass} value={o.waitingOnOthers} note="Review pending with someone else" tone="waiting" />
        <Metric href="/attention?queue=blocked" title="Blocked or overdue" icon={CircleAlert} value={o.blockedOrOverdue} note="Checks, conflicts, blocked or overdue planning" tone="blocked" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_minmax(340px,28%)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Your next tasks" icon={ListChecks} id="next-tasks" summary={`${next.total} ready${next.urgent ? `, ${next.urgent} urgent` : ""}`} actions={<Link href="/planning" className="btn">By project</Link>}>
            {next.top.length === 0 ? (
              <EmptyState icon={ListChecks} title="No tasks waiting for you">Tasks assigned to you that can start now show up here.</EmptyState>
            ) : (
              <>
                <ol>
                  {next.top.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
                      <div className="min-w-0"><Link href={`/tasks/${t.id}`} className="font-medium hover:underline [overflow-wrap:anywhere]">{t.title}</Link><p className="mt-0.5 text-[12px] text-ink-3">{t.project.name}</p></div>
                      <span className={`text-[12px] ${t.priority === 4 ? "font-medium text-blocked" : "text-ink-3"}`}>{PRIORITY_WORD[t.priority] ?? ""}</span>
                    </li>
                  ))}
                </ol>
                <p className="border-t border-line px-4 py-2 text-[12.5px]"><Link href="/tasks" className="link">All {next.total} ready tasks</Link> · open a project under <Link href="/planning" className="link">Planning</Link> to work through it in order</p>
              </>
            )}
          </Panel>

          <Panel title="Needs your attention" icon={BellRing} id="attn" actions={<Link href="/attention" className="btn">Open queue</Link>}>
            {o.attentionPreview.length === 0 ? (
              <EmptyState icon={BellRing} title={none ? "Nothing to review yet" : "You are clear"}>{repoCount === 0 ? "No repositories are connected yet." : "Nothing is waiting for your review right now."}</EmptyState>
            ) : (
              <ul className="fit-list" style={{ "--fit-min": "520px" } as React.CSSProperties}>
                {o.attentionPreview.map((d) => (
                  <li key={d.item.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 last:border-b-0">
                    <div className="min-w-0"><Link href={itemHref(d.item)} className="font-medium hover:underline [overflow-wrap:anywhere]">{d.item.title}</Link><p className="mt-0.5 text-[12px] text-ink-3"><Mono>{d.item.repository.fullName}#{d.item.number}</Mono></p></div>
                    <div className="flex items-center gap-2"><StatusPill status={d.derivation.primary} />{d.derivation.waiting && <span className="tnum text-[12px] text-ink-3">{formatDuration(d.derivation.waiting.elapsedMs)}</span>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Opened in the last 14 days" icon={Activity} id="opened" defaultOpen={false} summary={`${days.reduce((n, d) => n + d.count, 0)} opened`}>
            <div className="p-4"><OpenedChart days={days} today={todayIn(viewer.timezone, now)} /></div>
          </Panel>

          <Panel title="Recent activity" icon={Activity} id="recent" actions={<Link href="/activity" className="btn">All activity</Link>}>
            {activity.length === 0 ? <EmptyState title="No synchronized activity yet" /> : (
              <ul>{activity.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 border-b border-line px-4 py-2.5 text-[13px] last:border-b-0">
                  <Avatar login={a.actor ?? "?"} size={20} />
                  <div className="min-w-0 flex-1"><p className="[overflow-wrap:anywhere]"><span className="font-medium">{a.actor ?? "Someone"}</span> <Link href={a.href} className="hover:underline">{a.text}</Link></p><p className="text-[11.5px] text-ink-3"><Mono>{a.repo}</Mono> · <Time value={a.at} formatted={formatInstant(a.at, viewer.timezone)} /></p></div>
                </li>
              ))}</ul>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Daily digest" icon={Newspaper} id="digest" actions={<Link href="/digest" className="btn">Open digest</Link>}>
            {!digest ? <EmptyState icon={Newspaper} title="No digest yet">{isHosted() ? "The first one is made by the daily run." : "The first one is made on a morning Mergeport is open."}</EmptyState> : (
              <Link href={`/digest?day=${digest.day}`} className="block px-4 py-3 text-[13px] transition-colors duration-[var(--duration-feedback)] hover:bg-faint">
                <p className="flex items-center gap-2 font-medium">
                  {formatDateOnly(new Date(digest.day + "T00:00:00Z"))}
                  {!digest.readAt && <span className="rounded-full bg-ink px-1.5 text-[11px] font-normal leading-[18px] text-ink-invert">New</span>}
                </p>
                <dl className="tnum mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px] max-[420px]:grid-cols-1">
                  <div className="flex justify-between gap-3"><dt className="text-ink-3">Done</dt><dd className="font-medium">{digest.payload.counts.done}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-ink-3">Left undone</dt><dd className="font-medium">{digest.payload.counts.undone}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-ink-3">Needs you</dt><dd className="font-medium">{digest.payload.counts.mine}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-ink-3">Waiting on others</dt><dd className="font-medium">{digest.payload.counts.others}</dd></div>
                </dl>
              </Link>
            )}
          </Panel>

          <Panel title="Upcoming milestone" icon={Milestone} id="ms" actions={<Link href="/planning?view=roadmap" className="btn">Roadmap</Link>}>
            {!ms ? <EmptyState icon={Milestone} title="No upcoming milestone">Dashboard milestones with a future target date appear here.</EmptyState> : (
              <div className="p-4">
                <p className="font-medium">{ms.milestone.name}</p>
                <p className="text-[12.5px] text-ink-3">Target {formatDateOnly(ms.milestone.targetDate)}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${ms.milestone.name} visible work`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ms.progress.percent ?? undefined}><div className="meter-fill h-full bg-ink" style={{ "--v": `${ms.progress.percent ?? 0}%` } as React.CSSProperties} /></div>
                <p className="tnum mt-2 text-[12.5px]" title={`${ms.progress.label}: ${ms.progress.explanation}`}>{ms.progress.percent === null ? "No visible work yet" : `${ms.progress.done} of ${ms.progress.total} done`}</p>
                              </div>
            )}
          </Panel>

          <Panel title="Upstream status" icon={GitFork} id="up" actions={<Link href="/forks" className="btn">Forks</Link>}>
            {forks.length === 0 ? <EmptyState icon={GitFork} title="No tracked forks">Map a fork to its upstream to see missing commits.</EmptyState> : (
              <div className="p-4 text-[13px]">
                <p><span className="tnum font-medium">{behind.length}</span> of {forks.length} tracked fork{forks.length === 1 ? "" : "s"} missing upstream commits</p>
                {behind[0] && <Link href="/forks" className="mt-2 block text-[12.5px] text-ink-3 hover:text-ink"><Mono>{behind[0].fork.fullName}</Mono> is missing {behind[0].comparisons[0]?.behindBy} commit(s)</Link>}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
