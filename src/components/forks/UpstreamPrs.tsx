"use client";

import { useMemo, useState, useTransition } from "react";
import { ackManyAction } from "@/app/actions";
import { useToast } from "@/components/ui/ToastProvider";
import { Check, CircleHelp, ExternalLink, GitMerge, GitPullRequest, X } from "@/components/ui/icons";

type Evidence = "ANCESTRY_EXACT" | "PATCH_EQUIVALENT_POSSIBLE" | "MANUAL_ACK" | "NOT_DETECTED" | "UNKNOWN";
export type PrRow = { id: string; number: number; title: string; url: string; state: string; evidence: Evidence; note: string | null };

const EVIDENCE: Record<Evidence, { tone: "ok" | "waiting" | "needs" | "changes" | "unknown"; label: string; short: string }> = {
  ANCESTRY_EXACT: { tone: "ok", label: "Exact: merge commit is in fork history", short: "In the fork" },
  PATCH_EQUIVALENT_POSSIBLE: { tone: "waiting", label: "Possibly equivalent patch", short: "Maybe in the fork" },
  MANUAL_ACK: { tone: "needs", label: "Acknowledged by a person", short: "Acknowledged" },
  NOT_DETECTED: { tone: "changes", label: "Not detected (not proof of absence)", short: "Not detected" },
  UNKNOWN: { tone: "unknown", label: "Unknown", short: "Unknown" },
};
const PAGE = 25;
const settled = (r: PrRow) => r.evidence === "ANCESTRY_EXACT" || r.evidence === "MANUAL_ACK";
const needsLook = (r: PrRow) => r.state === "merged" && !settled(r);
type Filter = "look" | "open" | "done" | "all";

/**
 * Upstream pull requests for one fork. It opens on the merged ones whose presence in the fork is not settled; a reason that is the
 * same for many rows is said once above the list instead of under every row; many rows can be acknowledged at once.
 */
export function UpstreamPrs({ rows: initial, canEdit }: { rows: PrRow[]; canEdit: boolean }) {
  const { show } = useToast();
  const [rows, setRows] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setRows(initial);
  }
  const counts = useMemo(() => ({ look: rows.filter(needsLook).length, open: rows.filter((r) => r.state === "open").length, done: rows.filter((r) => r.state === "merged" && settled(r)).length, all: rows.length }), [rows]);
  const [filter, setFilter] = useState<Filter | null>(null);
  const active: Filter = filter ?? (counts.look ? "look" : counts.open ? "open" : "all");
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [, start] = useTransition();

  const visible = rows.filter((r) => (active === "all" ? true : active === "look" ? needsLook(r) : active === "open" ? r.state === "open" : r.state === "merged" && settled(r)));
  const shown = visible.slice(0, limit);

  // One shared explanation (for example "Ancestry could not be checked.") is shown once, not once per row.
  const shared = (() => {
    const m = new Map<string, number>();
    for (const r of visible) if (r.state === "merged" && r.note && !settled(r)) m.set(r.note, (m.get(r.note) ?? 0) + 1);
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 3 ? { note: top[0], n: top[1] } : null;
  })();

  const ack = (ids: string[]) => {
    const before = rows;
    setRows(rows.map((r) => (ids.includes(r.id) && r.state === "merged" ? { ...r, evidence: "MANUAL_ACK", note: "Acknowledged manually by a person. This is a decision, not Git evidence." } : r)));
    setPicked(new Set());
    start(async () => {
      const r = await ackManyAction({ ids });
      if (!r.ok) {
        setRows(before);
        show("error", r.error);
      } else if (ids.length > 1) show("ok", r.message ?? "Acknowledged");
    });
  };

  const tabs: { key: Filter; label: string }[] = [
    { key: "look", label: "Needs a look" },
    { key: "open", label: "Open upstream" },
    { key: "done", label: "In the fork" },
    { key: "all", label: "All" },
  ];
  const pickable = shown.filter((r) => needsLook(r));
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id));

  if (rows.length === 0) return <p className="text-[12.5px] text-ink-3">No upstream pull requests synchronized.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filter pull requests" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.key} type="button" aria-pressed={active === t.key} onClick={() => { setFilter(t.key); setLimit(PAGE); setPicked(new Set()); }} className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] ${active === t.key ? "border-ink bg-ink text-ink-invert" : "border-line bg-surface text-ink-2 hover:bg-hover"}`}>
            {t.label}<span className={`tnum ${active === t.key ? "opacity-80" : "text-ink-3"}`}>{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {shared && (
        <p className="flex items-start gap-2 rounded-[8px] border border-line bg-surface px-3 py-2 text-[12.5px] text-ink-2"><CircleHelp size={14} aria-hidden className="mt-0.5 shrink-0 text-ink-3" /><span><strong className="font-medium">{shared.n} pull requests:</strong> {shared.note}</span></p>
      )}

      {canEdit && picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface px-3 py-2 text-[12.5px]" role="region" aria-label="Selected pull requests">
          <strong className="font-medium">{picked.size} selected</strong>
          <button type="button" className="btn !h-7 !px-2.5 !text-[12.5px]" onClick={() => ack([...picked])}><Check size={13} aria-hidden /> Acknowledge</button>
          <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="rounded-[8px] border border-dashed border-line p-6 text-center text-[13px] text-ink-3">{active === "look" ? "Nothing here needs a look." : "No pull requests in this view."}</p>
      ) : (
        <ul className="overflow-hidden rounded-[8px] border border-line bg-surface">
          {canEdit && pickable.length > 1 && (
            <li className="flex items-center gap-3 border-b border-line bg-faint px-3 py-1.5 text-[12px] text-ink-3">
              <input type="checkbox" aria-label="Select all that need a look" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(pickable.map((r) => r.id)) : new Set())} />
              <span>{visible.length} pull request{visible.length === 1 ? "" : "s"}</span>
            </li>
          )}
          {shown.map((r) => {
            const e = EVIDENCE[r.evidence];
            const merged = r.state === "merged";
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-hover/50">
                {canEdit && <input type="checkbox" aria-label={`Select #${r.number}`} disabled={!needsLook(r)} checked={picked.has(r.id)} onChange={(ev) => setPicked((p) => { const n = new Set(p); if (ev.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />}
                <span className="tnum w-12 shrink-0 text-[12.5px] text-ink-3">#{r.number}</span>
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="group inline-flex min-w-[14rem] flex-1 items-start gap-1 text-[13.5px] font-medium text-ink hover:underline">
                  <span className="[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{r.title}</span>
                  <ExternalLink size={11} aria-hidden className="mt-1 shrink-0 opacity-0 group-hover:opacity-60" />
                </a>
                <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-ink-2">{merged ? <GitMerge size={14} aria-hidden className="text-[#8b5cf6]" /> : r.state === "open" ? <GitPullRequest size={14} aria-hidden className="text-ok" /> : <X size={14} aria-hidden className="text-ink-3" />}<span className="capitalize">{r.state}</span></span>
                {merged ? <span className={`pill pill-${e.tone}`} title={e.label}>{e.short}</span> : <span className="text-[12.5px] text-ink-3">Not merged yet</span>}
                {canEdit && merged && !settled(r) && <button type="button" className="btn !h-8" onClick={() => ack([r.id])} title="Record that you checked this and it is covered"><Check size={13} aria-hidden /> Acknowledge</button>}
                {merged && r.note && !shared?.note.includes(r.note) && r.note !== shared?.note && <p className="basis-full pl-[3.75rem] text-[11.5px] text-ink-3">{r.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {visible.length > shown.length && <button type="button" className="btn self-start" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, visible.length - shown.length)} more <span className="text-ink-3">of {visible.length - shown.length} left</span></button>}
    </div>
  );
}
