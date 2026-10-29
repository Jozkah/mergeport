import type { Db } from "@/lib/db";
import { requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { parseQuickActions, type QuickOp } from "@/lib/domain/quick-actions";
import { ValidationError } from "@/lib/errors";
import type { GithubPort } from "@/lib/github/port";
import { asLabels, asStrings } from "./queries";
import { loadTask, priorityName, updateTask } from "./tasks";
import { setAssignees, setLabels } from "./work-actions";

/**
 * Applies quick actions to a task (the dashboard's own record, shared with the team) or to a GitHub issue or pull request.
 * Every change is previewed first, in words, including where it is written. GitHub changes use the same functions, and so the same
 * authorization (a grant to manage work, the person's own credential), as the buttons on the item page.
 */
export type Target = { type: "task"; id: string } | { type: "work"; id: string };
export type PreviewLine = { text: string; writesTo: "dashboard" | "github"; ok: boolean; problem?: string };
export type QuickPreview = { lines: PreviewLine[]; errors: string[]; comment: string; canApply: boolean };

const cleanLabelList = (cur: string[], op: Extract<QuickOp, { kind: "label" | "unlabel" }>) => {
  const have = new Map(cur.map((l) => [l.toLowerCase(), l]));
  if (op.kind === "label") for (const n of op.names) have.set(n.toLowerCase(), have.get(n.toLowerCase()) ?? n);
  else for (const n of op.names) have.delete(n.toLowerCase());
  return [...have.values()];
};

export async function previewQuick(db: Db, v: Viewer, target: Target, text: string): Promise<QuickPreview> {
  const parsed = parseQuickActions(text);
  const lines: PreviewLine[] = [];
  if (target.type === "task") {
    const t = await loadTask(db, v, target.id);
    const cols = await db.planningColumn.findMany({ where: { projectId: t.projectId } });
    for (const op of parsed.ops) {
      if (t.workItemId && (op.kind === "label" || op.kind === "unlabel" || op.kind === "assign" || op.kind === "unassign")) {
        lines.push({ text: describe(op), writesTo: "dashboard", ok: false, problem: "This card follows a GitHub item. Open that item to change its labels or assignees." });
      } else if (op.kind === "move") {
        const c = cols.find((x) => x.key === op.column.toLowerCase().replace(/\s+/g, "-") || x.name.toLowerCase() === op.column.toLowerCase());
        lines.push(c ? { text: `Move to “${c.name}”`, writesTo: "dashboard", ok: true } : { text: describe(op), writesTo: "dashboard", ok: false, problem: `No column called “${op.column}”. Columns: ${cols.map((x) => x.key).join(", ")}` });
      } else lines.push({ text: describe(op), writesTo: "dashboard", ok: true });
    }
  } else {
    const item = await requireWorkItem(db, v, target.id, "manageWork");
    for (const op of parsed.ops) {
      if (op.kind === "label" || op.kind === "unlabel" || op.kind === "assign" || op.kind === "unassign") lines.push({ text: `${describe(op)} on ${item.type === "PULL_REQUEST" ? "pull request" : "issue"} #${item.number}`, writesTo: "github", ok: true });
      else lines.push({ text: describe(op), writesTo: "github", ok: false, problem: "Priority, due date and board column belong to a task, not to a GitHub item." });
    }
  }
  return { lines, errors: parsed.errors, comment: parsed.rest, canApply: lines.length > 0 && parsed.errors.length === 0 && lines.every((l) => l.ok) };
}

function describe(op: QuickOp): string {
  switch (op.kind) {
    case "assign": return op.login === "me" ? "Assign to you" : `Assign to @${op.login}`;
    case "unassign": return "Remove the assignee";
    case "priority": return `Set the priority to ${priorityName(op.value).toLowerCase()}`;
    case "due": return op.date ? `Set the due date to ${op.date}` : "Clear the due date";
    case "label": return `Add the label${op.names.length === 1 ? "" : "s"} ${op.names.join(", ")}`;
    case "unlabel": return `Remove the label${op.names.length === 1 ? "" : "s"} ${op.names.join(", ")}`;
    case "move": return `Move to “${op.column}”`;
  }
}

export async function applyQuick(ctx: { db: Db; v: Viewer; port?: GithubPort }, target: Target, text: string) {
  const { db, v } = ctx;
  const preview = await previewQuick(db, v, target, text);
  if (preview.errors.length) throw new ValidationError(preview.errors[0]);
  if (!preview.canApply) throw new ValidationError(preview.lines.find((l) => !l.ok)?.problem ?? "Nothing to apply");
  const ops = parseQuickActions(text).ops;
  if (target.type === "task") {
    const t = await loadTask(db, v, target.id);
    const patch: Parameters<typeof updateTask>[3] = {};
    let labels = asStrings(t.labels);
    let touchedLabels = false;
    const cols = await db.planningColumn.findMany({ where: { projectId: t.projectId } });
    for (const op of ops) {
      if (op.kind === "assign") patch.assigneeLogin = op.login === "me" ? v.login : op.login;
      else if (op.kind === "unassign") patch.assigneeLogin = null;
      else if (op.kind === "priority") patch.priority = op.value;
      else if (op.kind === "due") patch.dueDate = op.date ? new Date(op.date + "T00:00:00Z") : null;
      else if (op.kind === "label" || op.kind === "unlabel") {
        labels = cleanLabelList(labels, op);
        touchedLabels = true;
      } else if (op.kind === "move") patch.columnKey = cols.find((x) => x.key === op.column.toLowerCase().replace(/\s+/g, "-") || x.name.toLowerCase() === op.column.toLowerCase())!.key;
    }
    if (touchedLabels) patch.labels = labels;
    await updateTask(db, v, target.id, patch);
    return { applied: ops.length, writesTo: "dashboard" as const };
  }
  const item = await requireWorkItem(db, v, target.id, "manageWork");
  let labels = asLabels(item.labels).map((l) => l.name);
  let assignees = asStrings(item.assignees);
  let labelsChanged = false;
  let assigneesChanged = false;
  for (const op of ops) {
    if (op.kind === "label" || op.kind === "unlabel") {
      labels = cleanLabelList(labels, op);
      labelsChanged = true;
    } else if (op.kind === "assign") {
      const who = op.login === "me" ? v.login : op.login;
      if (!assignees.some((a) => a.toLowerCase() === who.toLowerCase())) assignees = [...assignees, who];
      assigneesChanged = true;
    } else if (op.kind === "unassign") {
      assignees = [];
      assigneesChanged = true;
    }
  }
  if (labelsChanged) await setLabels(ctx, target.id, labels);
  if (assigneesChanged) await setAssignees(ctx, target.id, assignees);
  return { applied: ops.length, writesTo: "github" as const };
}
