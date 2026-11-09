"use client";

import { useTransition } from "react";
import { setScopeAction } from "@/app/scope-actions";
import { Select } from "@/components/ui/Select";

/** Global / Project / Repository. The choice stays as you move between pages, and lists and counts follow it. */
export function ScopePicker({ value, projects, repos }: { value: string; projects: { id: string; name: string }[]; repos: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1.5" title="What the lists and counts cover">
      <label htmlFor="scope-picker" className="sr-only">Scope</label>
      <Select id="scope-picker" name="scope" className="select !h-8 !py-0 text-[12.5px]" value={value} disabled={pending} onChange={(e) => start(async () => void (await setScopeAction(e.target.value)))}>
        <option value="all">Everything</option>
        {projects.length > 0 && <optgroup label="Project">{projects.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup>}
        {repos.length > 0 && <optgroup label="Repository">{repos.map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}</optgroup>}
      </Select>
    </div>
  );
}
