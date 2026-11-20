import { beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { BASE, leaks } from "./helpers";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { loadViewer, projectWhere, requireProject, requireProjectWrite, type Viewer } from "@/lib/authz/viewer";
import { resolveScope } from "@/lib/scope";
import { createCard, milestoneProgress } from "@/lib/services/planning";
import { releaseReadiness } from "@/lib/services/planning-ext";
import { listProjects, searchGlobal, listRepositories } from "@/lib/services/queries";
import { createTask, getTask, listTasks, taskCounts, updateTask } from "@/lib/services/tasks";
import { planningBoard, roadmap } from "@/lib/services/planning-view";
import { gettingStarted } from "@/lib/services/getting-started";
import { dependencyGraph } from "@/lib/services/planning-insight";
import { createRestrictedSpace, deleteSpace, ensureCommonSpace, listMySpaces, listSpacesForAdmin, removeSpaceMember, setProjectAccessSpace, setSpaceMember } from "@/lib/services/access-spaces";

let db: Db;
let ids: DemoIds;
let admin: Viewer; // OWNER of the demo workspace
let a: Viewer; // MEMBER, in the restricted space with canWrite
let b: Viewer; // MEMBER, NOT in the restricted space
let n = 0;

const SECRET = "ZEBRA-RESTRICTED-TASK";

beforeEach(async () => {
  db = createTestPrisma(`spaces-acl-${n++}`);
  ids = await seedDemo(db, BASE);
  [admin, a, b] = (await Promise.all([ids.users.admin.id, ids.users.a.id, ids.users.b.id].map((id) => loadViewer(db, id)))) as Viewer[];
});

/** Puts the Atlas project, with a secret task, into a restricted space that only `a` is in. */
async function restrictAtlas(aCanWrite = true) {
  const space = await createRestrictedSpace(db, admin, "Skunkworks");
  await setSpaceMember(db, admin, space.id, ids.members.a.id, aCanWrite);
  const task = await createTask(db, admin, { projectId: ids.projects.atlas.id, title: SECRET, assigneeLogin: "alice-demo" });
  await setProjectAccessSpace(db, admin, ids.projects.atlas.id, space.id);
  return { space, task };
}

describe("a restricted space is invisible to people outside it", () => {
  it("every project list, scope, count and search hides it from a non-member, and shows it to a member", async () => {
    const { task } = await restrictAtlas();

    // b is outside: not one surface knows the project or its task exists
    expect((await listProjects(db, b)).map((p) => p.name)).toEqual(["Dashboard"]);
    expect((await listTasks(db, b)).map((t) => t.title)).not.toContain(SECRET);
    expect(leaks(await listTasks(db, b), SECRET)).toBe(false);
    expect((await searchGlobal(db, b, "ZEBRA")).planning).toHaveLength(0);
    expect(await db.project.findMany({ where: projectWhere(b), select: { name: true } })).toEqual([{ name: "Dashboard" }]);
    await expect(requireProject(db, b, ids.projects.atlas.id)).rejects.toThrow(NotFoundError);
    await expect(getTask(db, b, task.id)).rejects.toThrow(NotFoundError);
    await expect(planningBoard(db, b, ids.projects.atlas.id)).rejects.toThrow(NotFoundError);
    expect(leaks(await roadmap(db, b), "Atlas")).toBe(false);
    expect(leaks(await dependencyGraph(db, b), SECRET)).toBe(false);
    expect(leaks(await taskCounts(db, b), SECRET)).toBe(false);
    expect((await resolveScope(db, b, `project:${ids.projects.atlas.id}`)).kind).not.toBe("project");
    expect((await listRepositories(db, b)).flatMap((r) => r.projects.map((p) => p.project.name))).not.toContain("Atlas"); // project names on repository rows
    expect(leaks(await gettingStarted(db, b), "Atlas")).toBe(false);

    // a is inside
    expect((await listProjects(db, a)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
    expect((await listTasks(db, a)).map((t) => t.title)).toContain(SECRET);
    expect((await searchGlobal(db, a, "ZEBRA")).planning).toHaveLength(1);
    expect((await getTask(db, a, task.id)).task.title).toBe(SECRET);
  });

  it("the OWNER, who is not in the space, does not see inside either (they add themselves to look)", async () => {
    const { space, task } = await restrictAtlas();
    expect((await listProjects(db, admin)).map((p) => p.name)).toEqual(["Dashboard"]);
    await expect(getTask(db, admin, task.id)).rejects.toThrow(NotFoundError);
    expect((await searchGlobal(db, admin, "ZEBRA")).planning).toHaveLength(0);
    await setSpaceMember(db, admin, space.id, ids.members.admin.id, true);
    expect((await listProjects(db, admin)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
    expect((await getTask(db, admin, task.id)).task.title).toBe(SECRET);
  });

  it("removing a member from the space hides it again at once", async () => {
    const { task } = await restrictAtlas();
    expect((await getTask(db, a, task.id)).task.title).toBe(SECRET);
    await removeSpaceMember(db, admin, (await db.accessSpace.findFirstOrThrow({ where: { kind: "RESTRICTED" } })).id, ids.members.a.id);
    await expect(getTask(db, a, task.id)).rejects.toThrow(NotFoundError);
    expect((await listProjects(db, a)).map((p) => p.name)).toEqual(["Dashboard"]);
  });

  it("moving the project back to the common space shows it to everyone again", async () => {
    await restrictAtlas();
    await setProjectAccessSpace(db, admin, ids.projects.atlas.id, null).catch(() => {}); // the owner is not in the space: cannot even see the project
    const space = await db.accessSpace.findFirstOrThrow({ where: { kind: "RESTRICTED" } });
    await setSpaceMember(db, admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db, admin, ids.projects.atlas.id, null);
    expect((await listProjects(db, b)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
  });

  it("a project in no space and one in the COMMON space behave the same", async () => {
    const common = await ensureCommonSpace(db, ids.ws.id);
    await db.project.update({ where: { id: ids.projects.dash.id }, data: { accessSpaceId: common.id } });
    expect((await listProjects(db, b)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
  });
});

describe("counts and milestones do not reveal a restricted project to an administrator outside it", () => {
  it("a milestone of the project is not found, and a shared milestone's totals leave its cards out", async () => {
    const shared = await db.dashboardMilestone.create({ data: { workspaceId: ids.ws.id, name: "Shared", ownerId: ids.members.admin.id, targetDate: new Date("2026-12-01") } });
    await db.planningItem.update({ where: { id: ids.cards.cApiPr.id }, data: { milestoneId: shared.id } }); // an Atlas card
    expect((await releaseReadiness(db, admin, shared.id)).total).toBe(1);
    await restrictAtlas();
    await expect(releaseReadiness(db, admin, ids.milestone.id)).rejects.toThrow(NotFoundError); // the Beta milestone belongs to Atlas
    await expect(milestoneProgress(db, admin, ids.milestone.id)).rejects.toThrow(NotFoundError);
    const r = await releaseReadiness(db, admin, shared.id);
    expect(r.total).toBe(0);
    expect(r.hidden).toBe(0);
  });

  it("the getting-started task step counts only cards the person can see", async () => {
    await db.planningItem.deleteMany({ where: { projectId: ids.projects.dash.id } });
    await restrictAtlas();
    const step = (await gettingStarted(db, admin)).find((x) => x.key === "task")!;
    expect(step.done).toBe(false);
    expect((await gettingStarted(db, a)).find((x) => x.key === "task")!.done).toBe(true);
  });
});

describe("canWrite is honoured", () => {
  it("a member with canWrite edits; without it they read but cannot write", async () => {
    const { task } = await restrictAtlas(true);
    await updateTask(db, a, task.id, { title: "edited by a" });
    expect((await getTask(db, a, task.id)).task.title).toBe("edited by a");
    await createCard(db, a, { projectId: ids.projects.atlas.id, title: "a card" });

    const space = await db.accessSpace.findFirstOrThrow({ where: { kind: "RESTRICTED" } });
    await setSpaceMember(db, admin, space.id, ids.members.a.id, false);
    expect((await getTask(db, a, task.id)).task.title).toBe("edited by a"); // still reads
    await expect(updateTask(db, a, task.id, { title: "nope" })).rejects.toThrow(/read-only access to this space/);
    await expect(createCard(db, a, { projectId: ids.projects.atlas.id, title: "nope" })).rejects.toThrow(ForbiddenError);
    await expect(requireProjectWrite(db, a, ids.projects.atlas.id)).rejects.toThrow(ForbiddenError);
    expect((await getTask(db, a, task.id)).task.title).toBe("edited by a");
  });

  it("the role floor beats the space flag: a READER with canWrite still cannot write", async () => {
    await db.member.update({ where: { id: ids.members.b.id }, data: { role: "READER" } });
    const space = await createRestrictedSpace(db, admin, "Reads");
    await setSpaceMember(db, admin, space.id, ids.members.b.id, true);
    await setSpaceMember(db, admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db, admin, ids.projects.dash.id, space.id);
    const rv = (await loadViewer(db, ids.users.b.id))!;
    expect(rv.role).toBe("READER");
    expect((await requireProject(db, rv, ids.projects.dash.id)).id).toBe(ids.projects.dash.id); // can read
    await expect(requireProjectWrite(db, rv, ids.projects.dash.id)).rejects.toThrow(ForbiddenError);
  });

  it("a READER cannot write in the common space either", async () => {
    await db.member.update({ where: { id: ids.members.b.id }, data: { role: "READER" } });
    const rv = (await loadViewer(db, ids.users.b.id))!;
    expect((await listProjects(db, rv)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]); // reads fine
    await expect(createCard(db, rv, { projectId: ids.projects.dash.id, title: "x" })).rejects.toThrow(ForbiddenError);
    await expect(createTask(db, rv, { projectId: ids.projects.dash.id, title: "x" })).rejects.toThrow(ForbiddenError);
  });
});

describe("administering spaces", () => {
  it("only OWNER and ADMIN manage spaces; a member cannot even list them", async () => {
    await expect(createRestrictedSpace(db, a, "Nope")).rejects.toThrow(ForbiddenError);
    await expect(listSpacesForAdmin(db, a)).rejects.toThrow(ForbiddenError);
    await expect(setProjectAccessSpace(db, a, ids.projects.atlas.id, null)).rejects.toThrow(ForbiddenError);
    const adm = await addMember(db, ids.ws.id, "adm@example.com", "ADMIN");
    const space = await createRestrictedSpace(db, await adm.viewer(), "By admin");
    expect(space.id).toBeTruthy();
  });

  it("the common space is unique, cannot be deleted, and has implicit membership; restricted members must be active members of this workspace", async () => {
    const spaces = await listSpacesForAdmin(db, admin);
    const common = spaces.filter((s) => s.kind === "COMMON");
    expect(common).toHaveLength(1);
    await expect(deleteSpace(db, admin, common[0].id)).rejects.toThrow(ConflictError);
    await expect(setSpaceMember(db, admin, common[0].id, ids.members.a.id, true)).rejects.toThrow(ConflictError);
    await expect(db.accessSpace.create({ data: { workspaceId: ids.ws.id, kind: "COMMON", name: "second" } })).rejects.toThrow();
    const other = await workspaceWithOwner(db, "other@example.com", "Other");
    const stranger = await addMember(db, other.ws.id, "stranger@example.com", "MEMBER");
    const space = await createRestrictedSpace(db, admin, "S");
    await expect(setSpaceMember(db, admin, space.id, stranger.member.id, true)).rejects.toThrow(/active member of this workspace/);
    await expect(setSpaceMember(db, other.viewer, space.id, other.viewer.memberId, true)).rejects.toThrow(NotFoundError); // another workspace's space
  });

  it("a space that still holds projects cannot be deleted; an empty one can", async () => {
    const { space } = await restrictAtlas();
    await setSpaceMember(db, admin, space.id, ids.members.admin.id, true);
    await expect(deleteSpace(db, admin, space.id)).rejects.toThrow(/Move this space's projects/);
    await setProjectAccessSpace(db, admin, ids.projects.atlas.id, null);
    await deleteSpace(db, admin, space.id);
    expect(await db.accessSpace.count({ where: { workspaceId: ids.ws.id, kind: "RESTRICTED" } })).toBe(0);
  });

  it("listMySpaces shows the common space plus the restricted ones the person is in", async () => {
    await restrictAtlas(false);
    expect((await listMySpaces(db, b)).map((s) => s.kind)).toEqual(["COMMON"]);
    expect((await listMySpaces(db, a)).map((s) => `${s.kind}:${s.canWrite}`)).toEqual(["COMMON:true", "RESTRICTED:false"]);
  });

  it("another workspace's project cannot be moved into this workspace's space", async () => {
    const other = await workspaceWithOwner(db, "o2@example.com", "O2");
    const p = await db.project.create({ data: { workspaceId: other.ws.id, name: "Theirs", slug: "theirs" } });
    const space = await createRestrictedSpace(db, admin, "Mine");
    await expect(setProjectAccessSpace(db, admin, p.id, space.id)).rejects.toThrow(NotFoundError);
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).accessSpaceId).toBeNull();
  });
});
