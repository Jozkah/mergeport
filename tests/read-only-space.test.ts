import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { run } from "@/lib/action-result";
import { addComment, createTask, deleteTask, updateTask } from "@/lib/services/tasks";
import { addCheckItems } from "@/lib/services/checklist";
import { addDependency, createCard, moveCard } from "@/lib/services/planning";
import { assignEpic, createBoard, createEpic, createIteration, deleteBoard, setShipped, updateBoard } from "@/lib/services/planning-ext";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const MSG = /shared read-only with you/;

async function share(canWrite: boolean, backend: "GITHUB" | "HUB" = "GITHUB") {
  const { db, ids } = S;
  const space = await db.space.create({
    data: { workspaceId: S.a.workspaceId, remoteId: `sp-${canWrite}-${backend}`, teamRemoteId: "t1", kind: "COMMON", name: "Team", repoOwner: "o", repoName: backend === "HUB" ? "" : "r", backend, hubSpaceId: backend === "HUB" ? "hub-1" : "", canWrite, access: "OK" },
  });
  await db.project.update({ where: { id: ids.projects.atlas.id }, data: { spaceId: space.id } });
  return space;
}

describe("a member of a read-only space", () => {
  it("cannot create, edit, move, comment on or delete a task, and no outbox op appears", async () => {
    const { db, a, ids } = S;
    const projectId = ids.projects.atlas.id;
    const task = await createTask(db, a, { projectId, title: "before sharing" }); // made while the project was still local
    await share(false);

    await expect(createTask(db, a, { projectId, title: "nope" })).rejects.toThrow(MSG);
    await expect(createCard(db, a, { projectId, title: "nope" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateTask(db, a, task.id, { title: "renamed" })).rejects.toThrow(MSG);
    await expect(updateTask(db, a, task.id, { columnKey: "done" })).rejects.toThrow(MSG);
    await expect(moveCard(db, a, { itemId: task.id, toColumnKey: "done", expectedVersion: task.version })).rejects.toThrow(MSG);
    await expect(addComment(db, a, task.id, "hello")).rejects.toThrow(MSG);
    await expect(addCheckItems(db, a, task.id, "one")).rejects.toThrow(MSG);
    await expect(deleteTask(db, a, task.id)).rejects.toThrow(MSG);

    const after = await db.planningItem.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.title).toBe("before sharing");
    expect(after.version).toBe(task.version);
    expect(await db.taskComment.count({ where: { itemId: task.id, kind: "COMMENT" } })).toBe(0);
    expect(await db.taskCheckItem.count({ where: { itemId: task.id } })).toBe(0);
    expect(await db.outboxOp.count()).toBe(0);
  });

  it("can still read the project's tasks", async () => {
    const { db, a, ids } = S;
    const task = await createTask(db, a, { projectId: ids.projects.atlas.id, title: "readable" });
    await share(false);
    const { getTask, listTasks } = await import("@/lib/services/tasks");
    expect((await getTask(db, a, task.id)).task.title).toBe("readable");
    expect((await listTasks(db, a, { projectId: ids.projects.atlas.id })).map((t) => t.title)).toContain("readable");
  });
});

describe("writable places", () => {
  it("the same actions work in a writable space and in a local-only project", async () => {
    const { db, a, ids } = S;
    const projectId = ids.projects.atlas.id;
    const exercise = async (tag: string) => {
      const t = await createTask(db, a, { projectId, title: `${tag} task` });
      const other = await createTask(db, a, { projectId, title: `${tag} other` });
      await updateTask(db, a, t.id, { title: `${tag} renamed`, columnKey: "in-progress" });
      await addComment(db, a, t.id, "hello");
      await addCheckItems(db, a, t.id, "one");
      await addDependency(db, a, t.id, other.id);
      await deleteTask(db, a, other.id);
      expect((await db.planningItem.findUniqueOrThrow({ where: { id: t.id } })).title).toBe(`${tag} renamed`);
    };
    await exercise("local");
    await share(true);
    await exercise("writable");
  });
});

describe("a hub READER", () => {
  it("cannot edit planning boards, epics, iterations or milestones of a shared project", async () => {
    const { db, a, admin, ids } = S;
    const projectId = ids.projects.atlas.id;
    const board = await createBoard(db, a, { projectId, name: "Mine", template: "delivery" });
    const epic = await createEpic(db, a, { projectId, title: "Epic" });
    const card = await createTask(db, a, { projectId, title: "card" });
    const ms = await db.dashboardMilestone.create({ data: { workspaceId: admin.workspaceId, projectId, name: "M1", ownerId: admin.memberId } });
    await share(false, "HUB");

    await expect(createBoard(db, a, { projectId, name: "Another", template: "delivery" })).rejects.toThrow(MSG);
    await expect(updateBoard(db, a, board.id, { name: "Renamed" })).rejects.toThrow(MSG);
    await expect(deleteBoard(db, a, board.id)).rejects.toThrow(MSG);
    await expect(createEpic(db, a, { projectId, title: "E2" })).rejects.toThrow(MSG);
    await expect(assignEpic(db, a, card.id, epic.id)).rejects.toThrow(MSG);
    await expect(createIteration(db, a, { projectId, name: "S1", startDate: new Date("2026-11-01"), endDate: new Date("2026-11-14") })).rejects.toThrow(MSG);
    await expect(setShipped(db, admin, ms.id, true, { tag: "v1" })).rejects.toThrow(MSG);

    expect((await db.planBoard.findUniqueOrThrow({ where: { id: board.id } })).name).toBe("Mine");
    expect((await db.dashboardMilestone.findUniqueOrThrow({ where: { id: ms.id } })).shippedAt).toBeNull();
    expect(await db.outboxOp.count()).toBe(0);
  });
});

describe("action results", () => {
  it("ForbiddenError becomes the action's result message", async () => {
    const { db, a, ids } = S;
    await share(false);
    const r = await run(async () => {
      await createTask(db, a, { projectId: ids.projects.atlas.id, title: "nope" });
    });
    expect(r).toMatchObject({ ok: false, error: "This project is shared read-only with you" });
  });
});
