import { KINDS } from "@/lib/domain/notify-prefs";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listNotifications, recentActivity } from "@/lib/services/queries";
import { formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Avatar, EmptyState, Mono, PageHeader, Panel, Time } from "@/components/ui/primitives";
import { Activity, Bell } from "@/components/ui/icons";
import { markNotificationsReadAction } from "@/app/actions";

export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const { viewer } = await requireViewer();
  const [events, notes] = await Promise.all([recentActivity(db, viewer, 40), listNotifications(db, viewer)]);
  const unread = notes.filter((n) => !n.readAt).length;
  return (
    <>
      <PageHeader title="Activity" subtitle="Synchronized from GitHub for the repositories you can see. Notifications are dashboard records; nothing is emailed or posted." />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Recent activity" icon={Activity} id="act">
          {events.length === 0 ? <EmptyState icon={Activity} title="No activity yet" action={<Link href="/repositories/connect" className="btn btn-primary">Connect repositories</Link>}>Pull requests, issues and comments from your repositories show up here once they have synced.</EmptyState> : (
            <ul className="fit-list scroll-region" style={{ "--fit-min": "520px" } as React.CSSProperties}>{events.map((a) => (
              <li key={a.id} className="flex items-start gap-2.5 border-b border-line px-4 py-3 text-[13px] last:border-b-0">
                <Avatar login={a.actor ?? "?"} size={22} />
                <div className="min-w-0"><p className="[overflow-wrap:anywhere]"><span className="font-medium">{a.actor ?? "Someone"}</span> <Link href={a.href} className="hover:underline">{a.text}</Link></p><p className="text-[11.5px] text-ink-3"><Mono>{a.repo}</Mono> · <Time value={a.at} formatted={formatInstant(a.at, viewer.timezone)} /></p></div>
              </li>
            ))}</ul>
          )}
        </Panel>
        <Panel title={`Notifications${unread ? ` (${unread} unread)` : ""}`} icon={Bell} id="notes" actions={unread ? <ActionForm action={markNotificationsReadAction} submitLabel="Mark all read" submitClassName="btn" className="[&>div]:!mt-0">{null}</ActionForm> : undefined}>
          {notes.length === 0 ? <EmptyState icon={Bell} title="No notifications">You will see review requests for you here.</EmptyState> : (
            <div>
              {KINDS.map((k) => ({ k, rows: notes.filter((n) => n.kind === k.key) })).concat([{ k: { key: "other", label: "Other" } as never, rows: notes.filter((n) => !KINDS.some((x) => x.key === n.kind)) }]).filter((g) => g.rows.length > 0).map((g) => (
                <section key={g.k.key} aria-label={g.k.label}>
                  <h3 className="border-b border-line bg-surface px-4 py-1.5 text-[12px] font-medium text-ink-2">{g.k.key === "review-requested" ? "Review requests" : g.k.key === "changes-requested" ? "Changes requested on your pull requests" : "Other"} <span className="tnum text-ink-3">{g.rows.length}</span></h3>
                  <ul>{g.rows.map((n) => <li key={n.id} className={`border-b border-line px-4 py-3 text-[13px] last:border-b-0 ${n.readAt ? "" : "bg-faint"}`}>{n.href ? <Link href={n.href} className="hover:underline">{n.title}</Link> : n.title}<p className="text-[11.5px] text-ink-3"><Time value={n.createdAt} formatted={formatInstant(n.createdAt, viewer.timezone)} />{n.readAt ? "" : " · unread"}</p></li>)}</ul>
                </section>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
