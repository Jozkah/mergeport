import Link from "next/link";
import type { DigestEntry, DigestPayload, DigestSection } from "@/lib/services/digest";
import { Panel } from "@/components/ui/primitives";
import { RepoChip } from "@/components/ui/RepoChip";
import { BellRing, CircleCheck, Hourglass, ListChecks } from "@/components/ui/icons";

const age = (d: number | null) => (d === null ? null : d < 1 ? "today" : `${d} day${d === 1 ? "" : "s"}`);

function Entry({ e, showAge }: { e: DigestEntry; showAge: boolean }) {
  const a = showAge ? age(e.ageDays) : null;
  return (
    // The title link is stretched over the whole row so the hit area is the row, not one line of text.
    <li className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 transition-colors duration-[var(--duration-feedback)] hover:bg-faint has-[a:focus-visible]:bg-faint">
      <div className="min-w-0">
        <Link href={e.href} className="text-[13.5px] font-medium leading-snug text-pretty underline-offset-2 after:absolute after:inset-0 hover:underline [overflow-wrap:anywhere]">{e.title}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
          {e.repo && e.repo !== e.title && <RepoChip fullName={e.repo} />}
          <span className="text-ink-2">{e.reason}</span>
        </div>
      </div>
      {a && <span className="tnum shrink-0 text-[12px] text-ink-3" title={e.since ?? undefined}>{a}</span>}
    </li>
  );
}

function Block({ id, title, icon, section, empty, showAge }: { id: string; title: string; icon: typeof BellRing; section: DigestSection; empty: string; showAge: boolean }) {
  return (
    <Panel title={`${title} (${section.total})`} icon={icon} id={id}>
      {section.entries.length === 0 ? (
        // An empty part is one quiet line: three of four parts are often empty, and a full empty state each pushed the real entries below the fold.
        <p className="px-4 py-3 text-[13px] text-ink-3">{empty}</p>
      ) : (
        <>
          <ul>{section.entries.map((e) => <Entry key={e.key} e={e} showAge={showAge} />)}</ul>
          {section.more > 0 && <p className="tnum border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">and {section.more} more not shown</p>}
        </>
      )}
    </Panel>
  );
}

/** The four parts of a stored digest. Plain server component: everything it shows was written when the digest was generated. */
export function DigestView({ payload }: { payload: DigestPayload }) {
  return (
    <div className="fit-grid" style={{ "--fit-min": "520px" } as React.CSSProperties}>
      <Block id="digest-done" title="Done" icon={CircleCheck} section={payload.done} empty="Nothing finished that day" showAge={false} />
      <Block id="digest-undone" title="Left undone" icon={ListChecks} section={payload.undone} empty="Nothing was left undone" showAge />
      <Block id="digest-mine" title="Needs you" icon={BellRing} section={payload.attention.mine} empty="Nothing needs you" showAge />
      <Block id="digest-others" title="Waiting on others" icon={Hourglass} section={payload.attention.others} empty="You are not waiting on anyone" showAge />
    </div>
  );
}
