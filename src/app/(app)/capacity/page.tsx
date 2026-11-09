import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { reviewCapacity } from "@/lib/services/capacity";
import { formatDuration, formatInstant } from "@/lib/format";
import { availabilityAction } from "@/app/capacity-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { EmptyState, PageHeader, Panel, Avatar } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Users } from "@/components/ui/icons";

export const metadata = { title: "Review capacity" };

export default async function Capacity() {
  const { viewer } = await requireViewer();
  const now = new Date();
  const rows = await reviewCapacity(db, viewer, now);
  const mine = rows.find((r) => r.login.toLowerCase() === viewer.login.toLowerCase());
  const options = viewer.isAdmin ? rows : rows.filter((r) => r.login === mine?.login);
  return (
    <>
      <PageHeader title="Review capacity" subtitle="How many reviews are waiting on each person, and who covers for someone who is away. A backup is only suggested: nothing is reassigned and nobody is notified." />
      <Panel title="Who is reviewing what" icon={Users} id="capacity">
        {rows.length === 0 ? (
          <EmptyState icon={Users} title="No members yet">Members appear here once your team has joined.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Person</th><th className="px-4 py-2 font-medium">Waiting on them</th><th className="px-4 py-2 font-medium">Oldest</th><th className="px-4 py-2 font-medium">Availability</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.login}>
                    <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2"><Avatar login={r.login} size={18} />{r.login}</span></td>
                    <td className="tnum px-4 py-2.5">{r.queued}</td>
                    <td className="px-4 py-2.5 text-ink-3">{r.oldestSince ? (r.oldestItemId ? <Link href={`/pull-requests/${r.oldestItemId}`} className="link">{formatDuration(now.getTime() - r.oldestSince.getTime())}</Link> : formatDuration(now.getTime() - r.oldestSince.getTime())) : "-"}</td>
                    <td className="px-4 py-2.5">
                      {r.unavailable ? <span className="text-waiting">Away{r.unavailableUntil ? ` until ${formatInstant(r.unavailableUntil, viewer.timezone)}` : ""}{r.note ? ` (${r.note})` : ""}</span> : <span className="text-ink-3">Available{r.backup ? ` · backup ${r.backup}` : ""}</span>}
                      {r.suggestion && <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-[12px] text-ink-2">Suggest {r.suggestion} for their {r.queued} waiting</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={viewer.isAdmin ? "Set availability" : "Set my availability"} icon={Users} id="set-availability" className="mt-5">
        <ActionForm action={availabilityAction} submitLabel="Save" className="p-4" resetOnSuccess={false}>
          <div className="grid gap-3 md:grid-cols-2">
            <div><label className="label" htmlFor="av-login">Person</label><Select id="av-login" name="login" className="select" defaultValue={mine?.login ?? options[0]?.login}>{options.map((r) => <option key={r.login} value={r.login}>{r.login}</option>)}</Select></div>
            <div><label className="label" htmlFor="av-backup">Backup who covers (optional)</label><Select id="av-backup" name="backup" className="select" defaultValue=""><option value="">None</option>{rows.map((r) => <option key={r.login} value={r.login}>{r.login}</option>)}</Select></div>
            <div><label className="label" htmlFor="av-from">Away from</label><input id="av-from" name="from" type="date" className="input" /></div>
            <div><label className="label" htmlFor="av-until">Away until (inclusive)</label><input id="av-until" name="until" type="date" className="input" /></div>
            <div className="md:col-span-2"><label className="label" htmlFor="av-note">Note</label><input id="av-note" name="note" className="input" maxLength={200} placeholder="e.g. on leave" /></div>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">Shared with your team through your coordination repository. To clear an absence, save with both dates empty.</p>
        </ActionForm>
      </Panel>
    </>
  );
}
