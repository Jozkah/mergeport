"use client";

import { useMemo, useState, useTransition } from "react";
import { triageManyAction } from "@/app/actions";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { ExternalLink, Pencil, Search } from "@/components/ui/icons";

type Status = "UNTRIAGED" | "WATCHING" | "RELEVANT" | "ADDRESSED" | "IGNORED";
export type IssueRow = { id: string; number: number; title: string; url: string; status: Status; note: string | null };

const STATUSES: { key: Status; label: string; hint: string }[] = [
  { key: "UNTRIAGED", label: "Untriaged", hint: "Not looked at yet" },
  { key: "WATCHING", label: "Watching", hint: "Might matter; keep an eye on it" },
  { key: "RELEVANT", label: "Relevant", hint: "This fork needs it" },
  { key: "ADDRESSED", label: "Addressed", hint: "Already handled here" },
  { key: "IGNORED", label: "Ignored", hint: "Does not matter for this fork" },
];
const PAGE = 25;

/**
 * Upstream issues for one fork. A status change saves the moment it is chosen (no Save button per row); many rows can be set at
 * once; the list opens on what still needs a decision and shows 25 at a time, so hundreds of issues stay readable.
 */
export function UpstreamIssues({ rows: initial, canEdit }: { rows: IssueRow[]; canEdit: boolean }) {
  const { show } = useToast();
  const [rows, setRows] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setRows(initial);
  }
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const [filter, setFilter] = useState<Status | "ALL" | null>(null);
  const active = filter ?? (counts.UNTRIAGED ? "UNTRIAGED" : "ALL");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [, start] = useTransition();

  const visible = rows.filter((r) => (active === "ALL" || r.status === active) && (!q.trim() || `#${r.number} ${r.title} ${r.note ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  const shown = visible.slice(0, limit);

  const apply = (ids: string[], status: Status, note?: string | null) => {
    const before = rows;
    setRows(rows.map((r) => (ids.includes(r.id) ? { ...r, status, ...(note !== undefined ? { note } : {}) } : r)));
    setPicked(new Set());
    start(async () => {
      const r = await triageManyAction({ ids, status, note });
      if (!r.ok) {
        setRows(before);
        show("error", r.error);
      } else if (ids.length > 1) show("ok", r.message ?? "Saved");
    });
  };

  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {([{ key: "ALL" as const, label: "All" }, ...STATUSES]).map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={active === s.key}
              onClick={() => { setFilter(s.key); setLimit(PAGE); setPicked(new Set()); }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] ${active === s.key ? "border-ink bg-ink text-ink-invert" : "border-line bg-surface text-ink-2 hover:bg-hover"}`}
            >
              {s.key !== "ALL" && <span className="col-dot" data-triage={s.key} aria-hidden />}
              {s.label}
              <span className={`tnum ${active === s.key ? "opacity-80" : "text-ink-3"}`}>{counts[s.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto">
          <span className="sr-only">Search issues</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} className="input !h-8 !w-56 !pl-8" placeholder="Search issues" />
        </label>
      </div>

      {canEdit && picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface px-3 py-2 text-[12.5px]" role="region" aria-label="Selected issues">
          <strong className="font-medium">{picked.size} selected</strong>
          <span className="text-ink-3">Mark as</span>
          {STATUSES.map((s) => <button key={s.key} type="button" className="btn !h-7 !px-2.5 !text-[12.5px]" title={s.hint} onClick={() => apply([...picked], s.key)}><span className="col-dot" data-triage={s.key} aria-hidden />{s.label}</button>)}
          <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="rounded-[8px] border border-dashed border-line p-6 text-center text-[13px] text-ink-3">{rows.length === 0 ? "No upstream issues synchronized." : active === "UNTRIAGED" && !q ? "Everything has a decision. Nice." : "No issues match."}</p>
      ) : (
        <ul className="overflow-hidden rounded-[8px] border border-line bg-surface">
          {canEdit && (
            <li className="flex items-center gap-3 border-b border-line bg-faint px-3 py-1.5 text-[12px] text-ink-3">
              <input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
              <span>{visible.length} issue{visible.length === 1 ? "" : "s"}</span>
            </li>
          )}
          {shown.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-hover/50">
              {canEdit && <input type="checkbox" className="mt-1" aria-label={`Select #${r.number}`} checked={picked.has(r.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />}
              <span className="tnum mt-0.5 w-12 shrink-0 text-[12.5px] text-ink-3">#{r.number}</span>
              <div className="min-w-[14rem] flex-1">
                <a href={r.url} target="_blank" rel="noopener noreferrer" className={`group inline-flex items-start gap-1 text-[13.5px] font-medium hover:underline ${r.status === "IGNORED" || r.status === "ADDRESSED" ? "text-ink-3" : "text-ink"}`}>
                  <span className="[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{r.title}</span>
                  <ExternalLink size={11} aria-hidden className="mt-1 shrink-0 opacity-0 group-hover:opacity-60" />
                </a>
                {editing === r.id ? (
                  <form className="mt-1.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); apply([r.id], r.status, draft); setEditing(null); }}>
                    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} className="input !h-8" maxLength={500} placeholder="Why does it matter here?" aria-label={`Note for #${r.number}`} />
                    <button className="btn !h-8" type="submit">Save</button>
                  </form>
                ) : r.note ? (
                  <p className="mt-0.5 text-[12px] text-ink-3">{r.note}</p>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className="btn btn-quiet btn-icon !h-8 !w-8" aria-label={`${r.note ? "Edit" : "Add"} note for #${r.number}`} onClick={() => { setEditing(r.id); setDraft(r.note ?? ""); }}><Pencil size={13} aria-hidden /></button>
                  <Select aria-label={`Status of #${r.number}`} value={r.status} onChange={(e) => apply([r.id], e.target.value as Status)} className="select !h-8 !w-36 !text-[12.5px]">
                    {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </Select>
                </div>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2"><span className="col-dot" data-triage={r.status} aria-hidden />{STATUSES.find((s) => s.key === r.status)?.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {visible.length > shown.length && <button type="button" className="btn self-start" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, visible.length - shown.length)} more <span className="text-ink-3">of {visible.length - shown.length} left</span></button>}
    </div>
  );
}
