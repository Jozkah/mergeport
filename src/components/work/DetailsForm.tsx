"use client";

import { ActionForm } from "@/components/forms/ActionForm";
import { assigneesAction, labelsAction, milestoneAction } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";

const norm = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean).join(",");
const same = (a: string, b: string) => norm(a) === norm(b);

/**
 * Labels, assignees and milestone behind one Save. Each changed group is sent through its own existing server action, in order, with
 * the same form data; the first failure stops the rest and is reported with what was already saved.
 */
export function DetailsForm({ id, labels, assignees, milestone, milestonePlaceholder }: { id: string; labels: string; assignees: string; milestone: string; milestonePlaceholder: string }) {
  async function save(fd: FormData): Promise<ActionResult> {
    const steps = [
      { changed: !same(String(fd.get("labels") ?? ""), labels), run: labelsAction, name: "Labels" },
      { changed: !same(String(fd.get("assignees") ?? ""), assignees), run: assigneesAction, name: "Assignees" },
      { changed: String(fd.get("number") ?? "").trim() !== milestone, run: milestoneAction, name: "Milestone" },
    ].filter((s) => s.changed);
    if (steps.length === 0) return { ok: true, message: "Nothing changed", data: { neutral: true } };
    const done: string[] = [];
    for (const s of steps) {
      const r = await s.run(fd);
      if (!r.ok) return { ...r, error: done.length ? `${done.join(" and ")} saved. ${s.name}: ${r.error}` : r.error };
      done.push(s.name);
    }
    return { ok: true, message: `${done.join(", ")} updated` };
  }
  return (
    <ActionForm action={save} submitLabel="Save" submitClassName="btn" resetOnSuccess={false}>
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-col gap-3">
        <div><label className="label" htmlFor="d-labels">Labels</label><input id="d-labels" name="labels" className="input" defaultValue={labels} /></div>
        <div><label className="label" htmlFor="d-assign">Assignees</label><input id="d-assign" name="assignees" className="input" defaultValue={assignees} /></div>
        <div><label className="label" htmlFor="d-ms">Repository milestone number</label><input id="d-ms" name="number" inputMode="numeric" className="input" defaultValue={milestone} placeholder={milestonePlaceholder} /></div>
      </div>
    </ActionForm>
  );
}
