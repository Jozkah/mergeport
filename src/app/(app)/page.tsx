import { readScope, scopeKey } from "@/lib/scope";
import Link from "next/link";
import { requireViewer } from "@/lib/authz-page";
import { db } from "@/lib/db";
import { attentionFor } from "@/lib/services/request-cache";
import { openedPerDay, overview, recentActivity, visibleForkMappings } from "@/lib/services/queries";
import { milestoneProgress } from "@/lib/services/planning";
import { projectWhere, repoWhere } from "@/lib/authz/viewer";
import { formatDateOnly, formatDuration, formatInstant, isoDate } from "@/lib/format";
import { Avatar, EmptyState, Mono, Panel, StatusPill, Time } from "@/components/ui/primitives";
import { Activity, ArrowRight, BellRing, GitFork, Hourglass, Milestone, CircleAlert } from "@/components/ui/icons";
import { itemHref } from "@/components/work/WorkTable";
import { OpenedChart } from "@/components/work/OpenedChart";
import { Metric as AnimatedNumber } from "@/components/ui/Metric";
import { todayIn } from "@/lib/domain/planning";
import { GettingStarted } from "@/components/onboarding/GettingStarted";
import { gettingStarted } from "@/lib/services/getting-started";

export const metadata = { title: "Overview" };

function Metric({ href, title, icon: I, value, note, tone }: { href: string; title: string; icon: typeof BellRing; value: number; note: string; tone: "needs" | "waiting" | "blocked" }) {
  return (
    <Link href={href} className="panel spot-card block transition-shadow duration-[var(--duration-feedback)] hover:shadow-hair focus-visible:shadow-hair">
      <div className="panel-head !min-h-9"><span className="flex items-center gap-2 text-[14px] font-medium text-ink-2"><I size={16} aria-hidden className="text-ink-3" />{title}</span><ArrowRight size={14} aria-hidden className="text-ink-3" /></div>
      <div className="panel-body px-4 py-4"><p className={`text-[32px] font-medium leading-9 ${value > 0 ? (tone === "needs" ? "text-needs" : tone === "waiting" ? "text-waiting" : "text-blocked") : "text-ink-3"}`}><AnimatedNumber value={value} /></p><p className="mt-1 text-[12.5px] text-ink-3">{note}</p></div>
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
    recentActivity(db, viewer, 8),
    visibleForkMappings(db, viewer),
    db.dashboardMilestone.findMany({ where: { workspaceId: viewer.workspaceId, status: "OPEN", targetDate: { gte: new Date(todayIn(viewer.timezone, now) + "T00:00:00Z") }, OR: [{ projectId: null }, { project: projectWhere(viewer) }] }, orderBy: { targetDate: "asc" }, take: 1 }),
  ]);
  const ms = milestones[0] ? await milestoneProgress(db, viewer, milestones[0].id) : null;
  const behind = forks.filter((m) => (m.comparisons[0]?.behindBy ?? 0) > 0);
  const repoCount = await db.repository.count({ where: repoWhere(viewer) });
  const none = o.openIssues + o.openPrs === 0 && q.needsMyReview.length === 0;
  const steps = await gettingStarted(db, viewer);

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[24px] font-medium leading-8 tracking-[-0.01em]">Hello, {user.name?.split(" ")[0] ?? user.login}</h1>
        <p className="mt-1 text-[13px] text-ink-3">What needs you, and what is waiting on someone else, across the repositories you can see.</p>
      </div>

      <GettingStarted steps={steps} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric href="/attention?queue=needs-me" title="Needs my review" icon={BellRing} value={o.needsMyReview} note="Pull requests expecting you" tone="needs" />
        <Metric href="/attention?queue=waiting" title="Waiting on others" icon={Hourglass} value={o.waitingOnOthers} note="Review pending with someone else" tone="waiting" />
        <Metric href="/attention?queue=blocked" title="Blocked or overdue" icon={CircleAlert} value={o.blockedOrOverdue} note="Checks, conflicts, blocked or overdue planning" tone="blocked" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_minmax(340px,28%)]">
        <div className="flex min-w-0 flex-col gap-5">
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

          <Panel title="Opened in the last 14 days" icon={Activity} id="opened">
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
          <Panel title="Open work" icon={CircleAlert} id="open">
            <ul className="text-[13px]">
              <li><Link href="/pull-requests" className="flex items-center justify-between px-4 py-3 hover:bg-faint">Open pull requests<span className="font-medium"><AnimatedNumber value={o.openPrs} /></span></Link></li>
              <li className="border-t border-line"><Link href="/issues" className="flex items-center justify-between px-4 py-3 hover:bg-faint">Open issues<span className="font-medium"><AnimatedNumber value={o.openIssues} /></span></Link></li>
            </ul>
          </Panel>

          <Panel title="Upcoming milestone" icon={Milestone} id="ms" actions={<Link href="/planning?view=roadmap" className="btn">Roadmap</Link>}>
            {!ms ? <EmptyState icon={Milestone} title="No upcoming milestone">Dashboard milestones with a future target date appear here.</EmptyState> : (
              <div className="p-4">
                <p className="font-medium">{ms.milestone.name}</p>
                <p className="text-[12.5px] text-ink-3">Target {formatDateOnly(ms.milestone.targetDate)}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${ms.milestone.name} visible work`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ms.progress.percent ?? undefined}><div className="meter-fill h-full bg-ink" style={{ "--v": `${ms.progress.percent ?? 0}%` } as React.CSSProperties} /></div>
                <p className="tnum mt-2 text-[12.5px]">{ms.progress.percent === null ? "No visible work yet" : `${ms.progress.done} of ${ms.progress.total} done`}</p>
                <p className="mt-1 text-[11.5px] text-ink-3">{ms.progress.label}: {ms.progress.explanation}</p>
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
      <span className="sr-only">{isoDate(now)}</span>
    </>
  );
}
