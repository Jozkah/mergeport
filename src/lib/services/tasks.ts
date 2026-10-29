import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { requireProject, type Viewer } from "@/lib/authz/viewer";
import { positionBetween } from "@/lib/domain/planning";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "./audit";
import { createCard, listDependencies } from "./planning";
import { planningWhere } from "./queries";

/**
 * Tasks are planning cards seen as a work list: a title, a description, one assignee, a status (the board column), a priority,
 * a due date, labels and a comment thread. They are the same rows the board shows and they sync to the team the same way,
 * so assigning a task to someone makes it appear on their computer. People are GitHub logins, not local accounts.
 */

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const TASK_LABEL_MAX = 12;

export type TaskScope = "mine" | "by-me" | "unassigned" | "all";
export type TaskFilter = { scope?: TaskScope; projectId?: string; status?: "open" | "done" | "all"; column?: string; label?: string; q?: string; assignee?: string; openItems?: boolean };

export const cleanLogin = (raw: string | null | undefined): string | null => {
  const v = (raw ?? "").trim().replace(/^@/, "");
  if (!v) return null;
  if (!LOGIN.test(v)) throw new ValidationError("That is not a GitHub username");
  return v.toLowerCase(); // GitHub logins are case-insensitive: one canonical spelling
};

export const cleanLabels = (raw: string[] | string | undefined): string[] => {
  const list = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  const out: string[] = [];
  for (const l of list.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean)) {
    if (l.length > 30) throw new ValidationError("A label can have at most 30 characters");
    if (!out.some((o) => o.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  if (out.length > TASK_LABEL_MAX) throw new ValidationError(`A task can have at most ${TASK_LABEL_MAX} labels`);
  return out;
};

export async function loadTask(db: Db, v: Viewer, id: string) {
  const where = await planningWhere(db, v);
  const task = await db.planningItem.findFirst({ where: { AND: [where, { id }] }, include: { column: true, project: true } });
  if (!task) throw new NotFoundError();
  return task;
}

export async function listTasks(db: Db, v: Viewer, f: TaskFilter = {}) {
  const and: Prisma.PlanningItemWhereInput[] = [await planningWhere(db, v, f.projectId)];
  const me = v.login.toLowerCase();
  if (f.scope === "mine") and.push({ assigneeLogin: { equals: me } });
  else if (f.scope === "by-me") and.push({ assignedByLogin: { equals: me }, NOT: { assigneeLogin: { equals: me } } });
  else if (f.scope === "unassigned") and.push({ assigneeLogin: null });
  if (f.assignee) and.push({ assigneeLogin: f.assignee.toLowerCase().replace(/^@/, "") });
  if (f.openItems) and.push({ checklist: { some: { done: false } } });
  if (f.column) and.push({ column: { key: f.column } });
  else if ((f.status ?? "open") === "open") and.push({ column: { key: { not: "done" } } });
  else if (f.status === "done") and.push({ column: { key: "done" } });
  const q = f.q?.trim();
  if (q) and.push({ OR: [{ title: { contains: q } }, { description: { contains: q } }] });
  const rows = await db.planningItem.findMany({
    where: { AND: and },
    include: { column: true, project: { select: { id: true, name: true, slug: true } }, workItem: { select: { number: true, type: true, repository: { select: { fullName: true } } } }, _count: { select: { comments: { where: { kind: "COMMENT" } } } } },
    orderBy: [{ updatedAt: "desc" }],
    take: 500,
  });
  const progress = await checklistProgress(db, rows.map((r) => r.id));
  const label = f.label?.toLowerCase();
  return rows
    .filter((r) => !label || (r.labels as string[]).some((l) => l.toLowerCase() === label))
    .map((r) => ({ ...r, checklist: progress.get(r.id) ?? { done: 0, total: 0 } }));
}

export async function taskCounts(db: Db, v: Viewer) {
  const base = await planningWhere(db, v);
  const open = { column: { key: { not: "done" } } };
  const [mine, byMe, unassigned, all] = await Promise.all([
    db.planningItem.count({ where: { AND: [base, open, { assigneeLogin: v.login.toLowerCase() }] } }),
    db.planningItem.count({ where: { AND: [base, open, { assignedByLogin: v.login.toLowerCase(), NOT: { assigneeLogin: v.login.toLowerCase() } }] } }),
    db.planningItem.count({ where: { AND: [base, open, { assigneeLogin: null }] } }),
    db.planningItem.count({ where: { AND: [base, open] } }),
  ]);
  return { mine, byMe, unassigned, all };
}

/** Everyone a task in this project can be given to: members here, people seen on its repositories' issues, and people already on its tasks. */
export async function assigneeCandidates(db: Db, v: Viewer, projectId: string): Promise<string[]> {
  const project = await requireProject(db, v, projectId);
  const logins = new Map<string, string>();
  const add = (l: string | null | undefined) => {
    if (l && LOGIN.test(l) && !logins.has(l.toLowerCase())) logins.set(l.toLowerCase(), l);
  };
  add(v.login);
  const members = await db.projectMember.findMany({ where: { projectId: project.id }, include: { member: { include: { user: { select: { login: true } } } } } });
  for (const m of members) add(m.member.user.login);
  for (const t of await db.planningItem.findMany({ where: { projectId: project.id }, select: { assigneeLogin: true, authorLogin: true }, take: 1000 })) {
    add(t.assigneeLogin);
    add(t.authorLogin);
  }
  const repoIds = (await db.projectRepository.findMany({ where: { projectId: project.id }, select: { repositoryId: true } })).map((r) => r.repositoryId);
  if (repoIds.length) {
    for (const w of await db.workItem.findMany({ where: { repositoryId: { in: repoIds }, state: "OPEN" }, select: { authorLogin: true, assignees: true }, take: 400 })) {
      add(w.authorLogin);
      for (const a of (w.assignees as string[]) ?? []) add(a);
    }
  }
  return [...logins.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

async function event(db: Db, itemId: string, by: string, body: string) {
  await db.taskComment.create({ data: { itemId, authorLogin: by, kind: "EVENT", body } });
}

export async function createTask(
  db: Db,
  v: Viewer,
  input: { projectId: string; title: string; description?: string; assigneeLogin?: string | null; priority?: number; dueDate?: Date | null; labels?: string[] | string; columnKey?: string; milestoneId?: string | null },
) {
  const title = input.title?.trim();
  if (!title) throw new ValidationError("Give the task a title");
  if (title.length > 200) throw new ValidationError("The title can have at most 200 characters");
  const assignee = cleanLogin(input.assigneeLogin);
  const labels = cleanLabels(input.labels);
  const card = await createCard(db, v, { projectId: input.projectId, title, columnKey: input.columnKey, priority: input.priority, dueDate: input.dueDate, assigneeLogin: assignee, milestoneId: input.milestoneId });
  const task = await db.planningItem.update({
    where: { id: card.id },
    data: { description: input.description?.trim() || null, authorLogin: v.login, labels, assignedByLogin: assignee ? v.login.toLowerCase() : null },
  });
  await event(db, task.id, v.login, assignee ? (assignee === v.login.toLowerCase() ? "created this task and took it" : `created this task and assigned it to @${assignee}`) : "created this task");
  return task;
}

export type TaskPatch = { tickOpenItems?: boolean; title?: string; description?: string | null; assigneeLogin?: string | null; priority?: number; dueDate?: Date | null; labels?: string[] | string; columnKey?: string };

const PRIORITY = ["No priority", "Low", "Medium", "High", "Urgent"];
export const priorityName = (p: number) => PRIORITY[Math.max(0, Math.min(PRIORITY.length - 1, p))] ?? "No priority";

export async function updateTask(db: Db, v: Viewer, id: string, patch: TaskPatch) {
  const t = await loadTask(db, v, id);
  const data: Prisma.PlanningItemUpdateInput = { version: { increment: 1 } };
  const said: string[] = [];
  if (patch.title !== undefined && !t.workItemId) {
    const title = patch.title.trim();
    if (!title) throw new ValidationError("Give the task a title");
    if (title.length > 200) throw new ValidationError("The title can have at most 200 characters");
    if (title !== t.title) {
      data.title = title;
      said.push("renamed the task");
    }
  }
  if (patch.description !== undefined) {
    const d = patch.description?.trim() || null;
    if (d !== t.description) data.description = d;
  }
  if (patch.assigneeLogin !== undefined) {
    const a = cleanLogin(patch.assigneeLogin);
    if ((a ?? null) !== (t.assigneeLogin ?? null)) {
      data.assigneeLogin = a;
      data.assignedByLogin = a ? v.login.toLowerCase() : null;
      said.push(a ? (a === v.login.toLowerCase() ? "took this task" : `assigned this to @${a}`) : `unassigned @${t.assigneeLogin}`);
    }
  }
  if (patch.priority !== undefined) {
    const p = Math.round(patch.priority);
    if (!Number.isFinite(p) || p < 0 || p > 4) throw new ValidationError("Priority is 0 to 4");
    if (p !== t.priority) {
      data.priority = p;
      said.push(`set the priority to ${priorityName(p).toLowerCase()}`);
    }
  }
  if (patch.dueDate !== undefined) {
    const same = (patch.dueDate?.toISOString().slice(0, 10) ?? null) === (t.dueDate?.toISOString().slice(0, 10) ?? null);
    if (!same) {
      data.dueDate = patch.dueDate;
      said.push(patch.dueDate ? `set the due date to ${patch.dueDate.toISOString().slice(0, 10)}` : "cleared the due date");
    }
  }
  if (patch.labels !== undefined) {
    const labels = cleanLabels(patch.labels);
    if (JSON.stringify(labels) !== JSON.stringify(t.labels)) {
      data.labels = labels;
      said.push(labels.length ? `set the labels to ${labels.join(", ")}` : "cleared the labels");
    }
  }
  if (patch.columnKey !== undefined && patch.columnKey !== t.column.key) {
    const col = await db.planningColumn.findFirst({ where: { projectId: t.projectId, key: patch.columnKey } });
    if (!col) throw new ValidationError("Unknown status");
    const last = await db.planningItem.findFirst({ where: { columnId: col.id }, orderBy: { position: "desc" } });
    data.column = { connect: { id: col.id } };
    data.position = positionBetween(last?.position ?? null, null);
    said.push(`moved this to ${col.name}`);
  }
  if (patch.tickOpenItems && (patch.columnKey ?? t.column.key) === "done") {
    const open = await db.taskCheckItem.updateMany({ where: { itemId: id, done: false }, data: { done: true, doneByLogin: v.login, doneAt: new Date() } });
    if (open.count) said.push(`checked the remaining ${open.count} checklist item${open.count === 1 ? "" : "s"}`);
  }
  if (Object.keys(data).length === 1 && said.length === 0) return t; // nothing changed
  const updated = await db.planningItem.update({ where: { id }, data });
  for (const s of said) await event(db, id, v.login, s);
  await audit(db, v, "task.update", { type: "PlanningItem", id });
  return updated;
}

export async function getTask(db: Db, v: Viewer, id: string) {
  const t = await loadTask(db, v, id);
  const [comments, columns, full, dependencies] = await Promise.all([
    db.taskComment.findMany({ where: { itemId: id }, orderBy: { createdAt: "asc" }, take: 500 }),
    db.planningColumn.findMany({ where: { projectId: t.projectId }, orderBy: { position: "asc" } }),
    db.planningItem.findUniqueOrThrow({ where: { id }, include: { workItem: { include: { repository: { select: { fullName: true, htmlUrl: true } } } }, milestone: true } }),
    listDependencies(db, v, id),
  ]);
  const checklist = await db.taskCheckItem.findMany({ where: { itemId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return { task: t, full, comments, columns, checklist, dependencies };
}

export async function addComment(db: Db, v: Viewer, taskId: string, body: string) {
  await loadTask(db, v, taskId);
  const text = body.trim();
  if (!text) throw new ValidationError("Write a comment first");
  if (text.length > 8000) throw new ValidationError("A comment can have at most 8000 characters");
  const c = await db.taskComment.create({ data: { itemId: taskId, authorLogin: v.login, kind: "COMMENT", body: text } });
  await db.planningItem.update({ where: { id: taskId }, data: { updatedAt: new Date() } });
  return c;
}

async function ownComment(db: Db, v: Viewer, commentId: string) {
  const c = await db.taskComment.findUnique({ where: { id: commentId } });
  if (!c) throw new NotFoundError();
  await loadTask(db, v, c.itemId);
  if (c.kind !== "COMMENT") throw new ForbiddenError("System entries cannot be changed");
  return c;
}

export async function editComment(db: Db, v: Viewer, commentId: string, body: string) {
  const c = await ownComment(db, v, commentId);
  if (c.authorLogin.toLowerCase() !== v.login.toLowerCase()) throw new ForbiddenError("You can only edit your own comments");
  const text = body.trim();
  if (!text) throw new ValidationError("A comment cannot be empty");
  if (text.length > 8000) throw new ValidationError("A comment can have at most 8000 characters");
  return db.taskComment.update({ where: { id: commentId }, data: { body: text, editedAt: new Date() } });
}

export async function deleteComment(db: Db, v: Viewer, commentId: string) {
  const c = await ownComment(db, v, commentId);
  if (c.authorLogin.toLowerCase() !== v.login.toLowerCase() && !v.isAdmin) throw new ForbiddenError("You can only delete your own comments");
  await db.taskComment.delete({ where: { id: commentId } });
}

export async function deleteTask(db: Db, v: Viewer, id: string) {
  const t = await loadTask(db, v, id);
  if (t.workItemId) throw new ValidationError("This card follows a GitHub item. Remove it from the board instead");
  if (!v.isAdmin && t.authorLogin?.toLowerCase() !== v.login.toLowerCase() && t.createdById !== v.memberId) throw new ForbiddenError("Only the author or an administrator can delete a task");
  await db.planningItem.delete({ where: { id } });
  await audit(db, v, "task.delete", { type: "PlanningItem", id });
}

/** done/total per task, for badges on lists and the board. */
export async function checklistProgress(db: Db, ids: string[]): Promise<Map<string, { done: number; total: number }>> {
  const out = new Map<string, { done: number; total: number }>();
  if (!ids.length) return out;
  const rows = await db.taskCheckItem.groupBy({ by: ["itemId", "done"], where: { itemId: { in: ids } }, _count: { _all: true } });
  for (const r of rows) {
    const e = out.get(r.itemId) ?? { done: 0, total: 0 };
    e.total += r._count._all;
    if (r.done) e.done += r._count._all;
    out.set(r.itemId, e);
  }
  return out;
}
