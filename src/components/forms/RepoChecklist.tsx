"use client";

import { useState } from "react";

type R = { id: string; fullName: string; checked: boolean };

/** Checkbox list with a filter box, so choosing among dozens of repositories does not mean scrolling a wall of names. */
export function RepoChecklist({ repos, name }: { repos: R[]; name: string }) {
  const [q, setQ] = useState("");
  const [on, setOn] = useState(() => new Set(repos.filter((r) => r.checked).map((r) => r.id)));
  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setOn((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (ids: string[], v: boolean) => setOn((s) => { const n = new Set(s); for (const i of ids) { if (v) n.add(i); else n.delete(i); } return n; });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`f-${name}`}>Filter repositories</label>
        <input id={`f-${name}`} value={q} onChange={(e) => setQ(e.target.value)} className="input min-w-[160px] flex-1" placeholder="Filter repositories" />
        <button type="button" className="btn" onClick={() => setMany(shown.map((r) => r.id), true)}>Select shown</button>
        <button type="button" className="btn" onClick={() => setMany(shown.map((r) => r.id), false)}>Clear shown</button>
      </div>
      <p className="text-[12px] text-ink-3" aria-live="polite">{on.size} selected of {repos.length}</p>
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-[8px] border border-line p-1 text-[13px]">
        {shown.map((r) => (
          <li key={r.id}><label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 hover:bg-hover"><input type="checkbox" checked={on.has(r.id)} onChange={() => toggle(r.id)} /><span className="mono min-w-0 [overflow-wrap:anywhere]">{r.fullName}</span></label></li>
        ))}
        {shown.length === 0 && <li className="px-2 py-3 text-ink-3">No repository matches.</li>}
      </ul>
      {/* Selections hidden by the filter are still submitted. */}
      {[...on].map((id) => <input key={id} type="hidden" name={name} value={id} />)}
    </div>
  );
}
