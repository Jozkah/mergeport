"use client";

import { useId, useTransition } from "react";
import { setScopeAction } from "@/app/scope-actions";
import { Select } from "@/components/ui/Select";

/** Global / Project / Repository. The choice stays as you move between pages, and lists and counts follow it. */
export function ScopePicker({ value, projects, repos }: { value: string; projects: { id: string; name: string }[]; repos: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const id = useId(); // rendered once for the bar and once for the narrow row: ids must not collide
  return (
    <div className="flex min-w-0 items-center gap-1.5 [&_button]:w-full [&_button]:min-w-0" title="What the lists and counts cover">
      <label htmlFor={id} className="sr-only">Scope</label>
      <Select id={id} name="scope" className="select !h-8 !py-0 text-[12.5px]" value={value} disabled={pending} onChange={(e) => start(async () => void (await setScopeAction(e.target.value)))}>
        <option value="all">Everything</option>
        {projects.length > 0 && <optgroup label="Project">{projects.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup>}
        {repos.length > 0 && <optgroup label="Repository">{repos.map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}</optgroup>}
      </Select>
    </div>
  );
}
