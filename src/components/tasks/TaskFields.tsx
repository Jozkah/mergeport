import { AssigneeField } from "@/components/tasks/AssigneeField";
import { Select } from "@/components/ui/Select";

export const PRIORITIES = [
  { v: 0, label: "No priority" },
  { v: 1, label: "Low" },
  { v: 2, label: "Medium" },
  { v: 3, label: "High" },
  { v: 4, label: "Urgent" },
];

/** The fields every task form shares, so creating and editing look and behave the same. */
export function TaskFields({ people, me, values }: { people: string[]; me: string; values?: { assignee?: string; priority?: number; due?: string; labels?: string } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div><label className="label" htmlFor="t-assignee">Assignee</label><AssigneeField people={people} me={me} defaultValue={values?.assignee ?? ""} id="t-assignee" /></div>
      <div><label className="label" htmlFor="t-pri">Priority</label>
        <Select id="t-pri" name="priority" className="select" defaultValue={values?.priority ?? 0}>{PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}</Select></div>
      <div><label className="label" htmlFor="t-due">Due date</label><input id="t-due" name="due" type="date" className="input" defaultValue={values?.due ?? ""} /></div>
      <div><label className="label" htmlFor="t-labels">Labels</label><input id="t-labels" name="labels" className="input" defaultValue={values?.labels ?? ""} placeholder="bug, security" /></div>
    </div>
  );
}
