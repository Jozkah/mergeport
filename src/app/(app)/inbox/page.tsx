import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { inbox, type InboxStatus } from "@/lib/services/inbox";
import { formatInstant, formatInstantDated, relativeTime } from "@/lib/format";
import { EmptyState, PageHeader, Panel, Segmented, StatusPill, Avatar, Time } from "@/components/ui/primitives";
import { RepoChip } from "@/components/ui/RepoChip";
import { Inbox } from "@/components/ui/icons";
import { itemHref } from "@/components/work/WorkTable";
import { InboxRowActions, ReadAllButton } from "@/components/inbox/InboxActions";

export const metadata = { title: "Inbox" };

const TABS: { key: InboxStatus; label: string }[] = [
  { key: "open", label: "To do" },
  { key: "snoozed", label: "Snoozed" },
  { key: "done", label: "Done" },
];
const REASON = { "needs-review": "Review requested", "changes-requested": "Changes requested on yours" } as const;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "open") as InboxStatus;
  const now = new Date();
  const { entries, counts, unread } = await inbox(db, viewer, { now, status: tab });
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Pull requests waiting on you. Done clears it for you only."
        actions={<ReadAllButton disabled={unread === 0} />}
      />
      <div className="mb-4">
        <Segmented label="Inbox views" items={TABS.map((t) => ({ href: `/inbox?tab=${t.key}`, label: t.label, active: t.key === tab, count: counts[t.key] }))} />
      </div>
      <Panel title={TABS.find((t) => t.key === tab)!.label} icon={Inbox} id={`inbox-${tab}`}>
        {entries.length === 0 ? (
          <EmptyState icon={Inbox} title={tab === "open" ? "You are all caught up" : tab === "snoozed" ? "Nothing snoozed" : "Nothing marked done yet"}>
            {tab === "open" ? "New review requests and replies will show up here." : "Items you snooze or finish appear here."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((e) => {
              const me = viewer.login.toLowerCase();
              const requested = e.item.reviewRequests.filter((r) => !r.removedAt && r.kind === "USER" && r.reviewerRef.toLowerCase() === me).reduce((m, r) => Math.max(m, r.requestedAt.getTime()), 0);
              const at = (d: Date) => <Time value={d} formatted={formatInstantDated(d, viewer.timezone, now)} />;
              return (
              <li key={e.item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {e.unread && tab === "open" && <span aria-label="Unread" title="New since you last looked" className="size-2 shrink-0 rounded-full" style={{ background: "var(--sec)" }} />}
                    <Link data-row href={itemHref(e.item)} className="text-[13.5px] font-medium leading-snug underline-offset-2 hover:underline [overflow-wrap:anywhere]">{e.item.title}</Link>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                    <RepoChip fullName={e.item.repository.fullName} number={e.item.number} />
                    <span className="inline-flex items-center gap-1"><Avatar login={e.item.authorLogin ?? "?"} size={14} />{e.item.authorLogin ?? "unknown"}</span>
                    {e.reasons.map((r) => <span key={r} className="text-ink-2">{REASON[r]}</span>)}
                    <StatusPill status={e.derived.derivation.primary} />
                    {e.snoozeUntil && <span>Back {formatInstant(e.snoozeUntil, viewer.timezone)}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                    <span title={`Opened ${formatInstantDated(e.item.createdAtGh, viewer.timezone, now)}. Updated ${formatInstantDated(e.item.updatedAtGh, viewer.timezone, now)} (${relativeTime(e.item.updatedAtGh, now)}).`}>{requested > 0 ? <>Requested {at(new Date(requested))}</> : <>Updated {at(e.item.updatedAtGh)}</>}</span>
                  </div>
                </div>
                <InboxRowActions itemId={e.item.id} status={e.status} />
              </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
