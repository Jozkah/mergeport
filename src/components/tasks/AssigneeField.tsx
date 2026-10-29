"use client";

import { useState } from "react";
import { Select } from "@/components/ui/Select";

const OTHER = "__other__";

/**
 * Who a task is given to. The list is the people Mergeport already knows in this project; anyone else is typed as a GitHub
 * username, so a teammate who has not appeared yet can still be assigned. Submits one `assignee` value ("" = nobody).
 */
export function AssigneeField({ people, me, defaultValue = "", id = "assignee", name = "assignee" }: { people: string[]; me: string; defaultValue?: string; id?: string; name?: string }) {
  const known = defaultValue === "" || people.some((p) => p.toLowerCase() === defaultValue.toLowerCase());
  const [pick, setPick] = useState(known ? defaultValue : OTHER);
  const [typed, setTyped] = useState(known ? "" : defaultValue);
  const value = pick === OTHER ? typed.trim().replace(/^@/, "") : pick;
  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={value} />
      <Select id={id} value={pick} onChange={(e) => setPick(e.target.value)} className="select" aria-label="Assignee">
        <option value="">Unassigned</option>
        {people.map((p) => <option key={p} value={p}>{p === me ? `${p} (you)` : p}</option>)}
        <option value={OTHER}>Someone else…</option>
      </Select>
      {pick === OTHER && <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="GitHub username" aria-label="GitHub username of the assignee" autoComplete="off" spellCheck={false} />}
    </div>
  );
}
