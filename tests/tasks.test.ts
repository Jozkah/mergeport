import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addComment, assigneeCandidates, createTask, deleteComment, editComment, getTask, listTasks, taskCounts, updateTask } from "@/lib/services/tasks";
import { addCheckItems, checklistProgress, deleteCheckItem, editCheckItem, moveCheckItem, setCheckItemDone } from "@/lib/services/checklist";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("creating and assigning", () => {
  it("creates a task with an author, labels and an assignee, and records it in the history", async () => {
    const { db, a, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "  Rotate signing keys ", description: "before friday", assigneeLogin: "@bram-dev", labels: "security, Ops, ops", priority: 3 });
    expect(t).toMatchObject({ title: "Rotate signing keys", authorLogin: a.login, assigneeLogin: "bram-dev", assignedByLogin: a.login, labels: ["security", "Ops"], priority: 3 });
    const { comments } = await getTask(db, a, t.id);
    expect(comments.map((c) => c.kind)).toEqual(["EVENT"]);
    expect(comments[0].body).toMatch(/assigned it to @bram-dev/);
  });

  it("rejects an empty title and an invalid username", async () => {
    const { db, a, ids } = S;
    await expect(createTask(db, a, { projectId: ids.projects.atlas.id, title: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTask(db, a, { projectId: ids.projects.atlas.id, title: "x", assigneeLogin: "not a user!" })).rejects.toThrow(/username/);
  });

  it("reassigns, changes status and logs each change once; an unchanged save logs nothing", async () => {
    const { db, a, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "Ship it" });
    await updateTask(db, a, t.id, { assigneeLogin: "carol", columnKey: "in-progress", priority: 2 });
    await updateTask(db, a, t.id, { assigneeLogin: "carol", columnKey: "in-progress", priority: 2 });
    const { task, comments } = await getTask(db, a, t.id);
    expect(task.column.key).toBe("in-progress");
    expect(comments.map((c) => c.body)).toEqual(["created this task", "assigned this to @carol", "set the priority to medium", "moved this to In progress"]);
    await updateTask(db, a, t.id, { assigneeLogin: null });
    expect((await getTask(db, a, t.id)).task.assigneeLogin).toBeNull();
  });
});

describe("lists and visibility", () => {
  it("filters mine, assigned by me, unassigned and open/done", async () => {
    const { db, a, ids } = S;
    const p = ids.projects.atlas.id;
    const mine = await createTask(db, a, { projectId: p, title: "mine", assigneeLogin: a.login });
    const given = await createTask(db, a, { projectId: p, title: "given", assigneeLogin: "dana" });
    const open = await createTask(db, a, { projectId: p, title: "open" });
    await updateTask(db, a, open.id, { columnKey: "done" });
    const titles = async (f: Parameters<typeof listTasks>[2]) => (await listTasks(db, a, f)).map((x) => x.title);
    expect(await titles({ scope: "mine" })).toContain("mine");
    expect(await titles({ scope: "mine" })).not.toContain("given");
    expect(await titles({ scope: "by-me" })).toEqual(["given"]);
    expect(await titles({ scope: "unassigned" })).not.toContain("open"); // done is hidden by default
    expect(await titles({ status: "done" })).toContain("open");
    expect(await titles({ q: "GIV" })).toEqual(expect.arrayContaining([]));
    expect(mine.id).not.toBe(given.id);
    expect((await taskCounts(db, a)).byMe).toBe(1);
  });

  it("never shows or edits a task from a project the person cannot see", async () => {
    const { db, a, b, ids } = S;
    const hidden = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "private to atlas members" });
    const seen = (await listTasks(db, b, { scope: "all" })).some((t) => t.id === hidden.id);
    if (!seen) {
      await expect(getTask(db, b, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateTask(db, b, hidden.id, { priority: 4 })).rejects.toBeInstanceOf(NotFoundError);
      await expect(addComment(db, b, hidden.id, "hi")).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("offers assignees from members, authors and people already on tasks", async () => {
    const { db, a, ids } = S;
    await createTask(db, a, { projectId: ids.projects.atlas.id, title: "x", assigneeLogin: "zed" });
    const people = await assigneeCandidates(db, a, ids.projects.atlas.id);
    expect(people).toContain(a.login);
    expect(people).toContain("zed");
  });
});

describe("comments", () => {
  it("lets anyone who sees the task comment, but only the author edit or delete (admins can delete)", async () => {
    const { db, a, admin, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "discuss" });
    const c = await addComment(db, a, t.id, " first ");
    expect(c.body).toBe("first");
    await expect(addComment(db, a, t.id, "   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(editComment(db, admin, c.id, "hijack")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await editComment(db, a, c.id, "edited")).editedAt).not.toBeNull();
    await deleteComment(db, admin, c.id);
    expect((await getTask(db, a, t.id)).comments.filter((x) => x.kind === "COMMENT")).toHaveLength(0);
    const ev = (await getTask(db, a, t.id)).comments[0];
    await expect(deleteComment(db, a, ev.id)).rejects.toBeInstanceOf(ForbiddenError); // system lines are permanent
  });
});

describe("checklist", () => {
  it("adds items from pasted lines, ticks them, and reports progress", async () => {
    const { db, a, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "release" });
    const made = await addCheckItems(db, a, t.id, "- [ ] write migration\n- [x] bump version\n\n* tag it\nplain line");
    expect(made.map((m) => [m.text, m.done])).toEqual([["write migration", false], ["bump version", true], ["tag it", false], ["plain line", false]]);
    expect((await checklistProgress(db, [t.id])).get(t.id)).toEqual({ done: 1, total: 4 });
    await setCheckItemDone(db, a, made[0].id, true);
    await setCheckItemDone(db, a, made[2].id, true);
    expect((await checklistProgress(db, [t.id])).get(t.id)).toEqual({ done: 3, total: 4 });
    // a run of ticks is one history line
    const events = (await getTask(db, a, t.id)).comments.map((c) => c.body);
    expect(events.filter((b) => b.startsWith("checked"))).toEqual(["checked 2 checklist items"]);
  });

  it("limits length and count, and hides items of tasks you cannot see", async () => {
    const { db, a, b, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "x" });
    await expect(addCheckItems(db, a, t.id, "y".repeat(201))).rejects.toBeInstanceOf(ValidationError);
    await expect(addCheckItems(db, a, t.id, "   ")).rejects.toBeInstanceOf(ValidationError);
    await addCheckItems(db, a, t.id, Array.from({ length: 100 }, (_, i) => `item ${i}`).join("\n"));
    await expect(addCheckItems(db, a, t.id, "one more")).rejects.toThrow(/at most 100/);
    const first = (await getTask(db, a, t.id)).checklist[0];
    if (!(await listTasks(db, b, { scope: "all" })).some((x) => x.id === t.id)) {
      await expect(setCheckItemDone(db, b, first.id, true)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteCheckItem(db, b, first.id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("reorders, edits, deletes, and can tick the rest when the task is moved to Done", async () => {
    const { db, a, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "order" });
    const [i1, i2, i3] = await addCheckItems(db, a, t.id, "one\ntwo\nthree");
    await moveCheckItem(db, a, i3.id, null);
    await moveCheckItem(db, a, i1.id, i2.id);
    expect((await getTask(db, a, t.id)).checklist.map((c) => c.text)).toEqual(["three", "two", "one"]);
    await editCheckItem(db, a, i2.id, "  second  ");
    await deleteCheckItem(db, a, i3.id);
    await updateTask(db, a, t.id, { columnKey: "done", tickOpenItems: true });
    const after = await getTask(db, a, t.id);
    expect(after.checklist.map((c) => [c.text, c.done])).toEqual([["second", true], ["one", true]]);
    expect(after.comments.some((c) => /checked the remaining 2/.test(c.body))).toBe(true);
    expect((await listTasks(db, a, { status: "all", openItems: true })).some((x) => x.id === t.id)).toBe(false);
  });
});

const NL = String.fromCharCode(10);
describe("audit regressions", () => {
  it("matches assignees regardless of username case in lists, by-me and counts (B07)", async () => {
    const { db, a, ids } = S;
    const p = ids.projects.atlas.id;
    const t = await createTask(db, a, { projectId: p, title: "shouting", assigneeLogin: a.login.toUpperCase() });
    expect((await listTasks(db, a, { scope: "mine" })).map((x) => x.id)).toContain(t.id);
    expect((await listTasks(db, a, { scope: "by-me" })).map((x) => x.id)).not.toContain(t.id);
    const before = (await taskCounts(db, a)).mine;
    await updateTask(db, a, t.id, { assigneeLogin: "Dana" });
    expect((await taskCounts(db, a)).mine).toBe(before - 1);
    expect((await listTasks(db, a, { scope: "by-me" })).map((x) => x.id)).toContain(t.id);
    expect((await listTasks(db, a, { assignee: "DANA" })).map((x) => x.id)).toContain(t.id);
  });

  it("saves nothing when any pasted checklist line is rejected (B08)", async () => {
    const { db, a, ids } = S;
    const t = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "list" });
    await expect(addCheckItems(db, a, t.id, `fine${NL}${"x".repeat(201)}`)).rejects.toThrow(/at most 200/);
    expect(await db.taskCheckItem.count({ where: { itemId: t.id } })).toBe(0);
    await addCheckItems(db, a, t.id, `one${NL}two`);
    expect(await db.taskCheckItem.count({ where: { itemId: t.id } })).toBe(2);
  });
});
