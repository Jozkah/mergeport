import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { positionBetween } from "@/lib/domain/planning";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { loadTask } from "./tasks";

export const CHECKLIST_MAX_ITEMS = 100;
export const CHECKLIST_ITEM_MAX = 200;

export { checklistProgress } from "./tasks";

/** "- [ ] text", "- [x] text", "* text" and plain lines all become items. Blank lines are skipped. */
export function parseChecklistLines(raw: string): { text: string; done: boolean }[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(l);
      if (m) return { text: m[2].trim(), done: m[1].toLowerCase() === "x" };
      return { text: l.replace(/^[-*]\s+/, "").trim(), done: false };
    })
    .filter((i) => i.text);
}

const cleanItemText = (raw: string) => {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) throw new ValidationError("Write the checklist item first");
  if (t.length > CHECKLIST_ITEM_MAX) throw new ValidationError(`A checklist item can have at most ${CHECKLIST_ITEM_MAX} characters`);
  return t;
};

/** Adds one item per line. Returns the created items. */
export async function addCheckItems(db: Db, v: Viewer, taskId: string, raw: string) {
  await loadTask(db, v, taskId);
  const parsed = parseChecklistLines(raw);
  if (!parsed.length) throw new ValidationError("Write the checklist item first");
  // Validate the whole paste before writing anything, then write it as one unit: a rejected paste changes nothing.
  const clean = parsed.map((p) => ({ text: cleanItemText(p.text), done: p.done }));
  return db.$transaction(async (tx) => {
    const existing = await tx.taskCheckItem.count({ where: { itemId: taskId } });
    if (existing + clean.length > CHECKLIST_MAX_ITEMS) throw new ValidationError(`A task can have at most ${CHECKLIST_MAX_ITEMS} checklist items`);
    const last = await tx.taskCheckItem.findFirst({ where: { itemId: taskId }, orderBy: { position: "desc" } });
    let pos = last?.position ?? 0;
    const created = [];
    for (const p of clean) {
      pos += 1024;
      created.push(await tx.taskCheckItem.create({ data: { itemId: taskId, text: p.text, done: p.done, doneByLogin: p.done ? v.login : null, doneAt: p.done ? new Date() : null, position: pos } }));
    }
    await tx.planningItem.update({ where: { id: taskId }, data: { updatedAt: new Date() } });
    return created;
  });
}

async function loadCheckItem(db: Db, v: Viewer, id: string) {
  const c = await db.taskCheckItem.findUnique({ where: { id } });
  if (!c) throw new NotFoundError();
  await loadTask(db, v, c.itemId);
  return c;
}

/** A run of ticks within a minute is one history line ("checked 3 checklist items"), not one line per box. */
async function logTick(db: Db, v: Viewer, taskId: string, verb: "checked" | "unchecked", text: string) {
  const last = await db.taskComment.findFirst({ where: { itemId: taskId }, orderBy: { createdAt: "desc" } });
  if (last && last.kind === "EVENT" && last.authorLogin === v.login && Date.now() - last.createdAt.getTime() < 60_000) {
    const m = new RegExp(`^${verb} (?:“.*”|(\\d+) checklist items)$`).exec(last.body);
    if (m) {
      const n = m[1] ? Number(m[1]) + 1 : 2;
      await db.taskComment.update({ where: { id: last.id }, data: { body: `${verb} ${n} checklist items` } });
      return;
    }
  }
  await db.taskComment.create({ data: { itemId: taskId, authorLogin: v.login, kind: "EVENT", body: `${verb} “${text.length > 60 ? text.slice(0, 57) + "…" : text}”` } });
}

export async function setCheckItemDone(db: Db, v: Viewer, id: string, done: boolean) {
  const c = await loadCheckItem(db, v, id);
  if (c.done === done) return c;
  const u = await db.taskCheckItem.update({ where: { id }, data: { done, doneByLogin: done ? v.login : null, doneAt: done ? new Date() : null } });
  await db.planningItem.update({ where: { id: c.itemId }, data: { updatedAt: new Date() } });
  await logTick(db, v, c.itemId, done ? "checked" : "unchecked", c.text);
  return u;
}

export async function editCheckItem(db: Db, v: Viewer, id: string, text: string) {
  const c = await loadCheckItem(db, v, id);
  return db.taskCheckItem.update({ where: { id: c.id }, data: { text: cleanItemText(text) } });
}

export async function deleteCheckItem(db: Db, v: Viewer, id: string) {
  const c = await loadCheckItem(db, v, id);
  await db.taskCheckItem.delete({ where: { id: c.id } });
}

/** Put the item after `afterId` (null = first). */
export async function moveCheckItem(db: Db, v: Viewer, id: string, afterId: string | null) {
  const c = await loadCheckItem(db, v, id);
  const all = await db.taskCheckItem.findMany({ where: { itemId: c.itemId, NOT: { id } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  let idx = 0;
  if (afterId) {
    const i = all.findIndex((x) => x.id === afterId);
    if (i < 0) throw new ValidationError("That item is not on this task");
    idx = i + 1;
  }
  const before = idx > 0 ? all[idx - 1].position : null;
  const after = idx < all.length ? all[idx].position : null;
  return db.taskCheckItem.update({ where: { id }, data: { position: positionBetween(before, after) } });
}
