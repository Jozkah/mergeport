import { beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { BASE } from "./helpers";
import { workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { exportBackup, parseBackup, restoreBackup, type Backup } from "@/lib/services/backup";
import { createRestrictedSpace, ensureCommonSpace, setProjectAccessSpace, setSpaceMember } from "@/lib/services/access-spaces";
import { createTask } from "@/lib/services/tasks";

let db: Db;
let ids: DemoIds;
let admin: Viewer;
let n = 0;
const SECRET = "ZEBRA-BACKUP-TASK";

beforeEach(async () => {
  db = createTestPrisma(`backup-acl-${n++}`);
  ids = await seedDemo(db, BASE);
  admin = (await loadViewer(db, ids.users.admin.id))!;
});

/** Atlas goes into a restricted space; the OWNER is in it only while `adminIn`. */
async function restrictAtlas() {
  await createTask(db, admin, { projectId: ids.projects.atlas.id, title: SECRET });
  const space = await createRestrictedSpace(db, admin, "Skunkworks");
  await setSpaceMember(db, admin, space.id, ids.members.a.id, true);
  await setSpaceMember(db, admin, space.id, ids.members.admin.id, true);
  await setProjectAccessSpace(db, admin, ids.projects.atlas.id, space.id);
  return space;
}
const leaveSpace = (spaceId: string) => db.accessSpaceMember.deleteMany({ where: { spaceId, memberId: ids.members.admin.id } });
const names = (b: Backup, t: string) => (b.tables[t] ?? []).map((r) => String(r.name ?? r.title ?? r.body ?? r.id));

describe("backup export honours the space ACL", () => {
  it("an administrator outside a restricted space exports none of its projects, cards or comments; inside it, all of them", async () => {
    const space = await restrictAtlas();
    const full = JSON.parse(await exportBackup(db, admin)) as Backup;
    expect(names(full, "Project")).toContain("Atlas");
    expect(JSON.stringify(full)).toContain(SECRET);

    await leaveSpace(space.id);
    const text = await exportBackup(db, admin);
    const out = JSON.parse(text) as Backup;
    expect(names(out, "Project")).toEqual(["Dashboard"]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ids.projects.atlas.id);
    for (const t of ["PlanningItem", "PlanningColumn", "PlanEvent", "Epic", "Iteration", "PlanBoard", "ProjectRepository"]) {
      expect((out.tables[t] ?? []).every((r) => r.projectId !== ids.projects.atlas.id)).toBe(true);
    }
    expect((out.tables.DashboardMilestone ?? []).filter((r) => r.projectId === ids.projects.atlas.id)).toHaveLength(0); // the Beta milestone belongs to Atlas
  });
});

describe("backup restore honours the space ACL", () => {
  it("cannot overwrite a project the viewer cannot see, nor add to its cards", async () => {
    const space = await restrictAtlas();
    const crafted = JSON.parse(await exportBackup(db, admin)) as Backup; // made while the admin was inside
    await leaveSpace(space.id);
    const tamper = (crafted.tables.Project ?? []).find((p) => p.id === ids.projects.atlas.id)!;
    tamper.name = "HACKED";
    const item = (crafted.tables.PlanningItem ?? []).find((r) => r.projectId === ids.projects.atlas.id && r.title === SECRET)!;
    item.title = "HACKED-CARD";
    const r = await restoreBackup(db, admin, parseBackup(JSON.stringify(crafted, (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v))), { confirmed: true });
    expect(r).toBeTruthy();
    expect((await db.project.findUniqueOrThrow({ where: { id: ids.projects.atlas.id } })).name).toBe("Atlas");
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: item.id as string } })).title).toBe(SECRET);
  });

  it("validates accessSpaceId: another workspace's space, or a restricted space you are not in, skips the project (never null = common)", async () => {
    const other = await workspaceWithOwner(db, "other@example.com", "Other");
    const theirs = await createRestrictedSpace(db, other.viewer, "Theirs");
    const mine = await createRestrictedSpace(db, admin, "Not mine"); // the OWNER is not in it
    const common = await ensureCommonSpace(db, ids.ws.id);
    const base = JSON.parse(await exportBackup(db, admin)) as Backup;
    const tmpl = base.tables.Project[0];
    const mk = (id: string, accessSpaceId: string | null) => ({ ...tmpl, id, slug: id, name: id, accessSpaceId });
    base.tables.Project = [mk("p-foreign", theirs.id), mk("p-restricted", mine.id), mk("p-common", common.id), mk("p-none", null)];
    base.tables.ProjectRepository = [];
    for (const t of ["PlanningColumn", "DashboardMilestone", "Epic", "Iteration", "PlanBoard", "PlanningItem", "PlanningLink", "TaskComment", "TaskCheckItem", "PlanEvent", "ReviewRule", "WaitingRule"]) base.tables[t] = [];
    await restoreBackup(db, admin, parseBackup(JSON.stringify(base)), { confirmed: true });
    const got = Object.fromEntries((await db.project.findMany({ where: { id: { startsWith: "p-" } } })).map((p) => [p.id, p.accessSpaceId]));
    expect(got).toEqual({ "p-common": common.id, "p-none": null });
  });
});
