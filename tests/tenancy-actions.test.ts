import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import { truncateAll } from "@/lib/demo/seed";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { forEachWorkspace } from "@/lib/local/handlers";
import { exportBackup, parseBackup, restoreBackup } from "@/lib/services/backup";
import { createColumnsForProject } from "@/lib/services/planning";
import { createTask } from "@/lib/services/tasks";
import { testDb } from "./helpers";

const mocks = vi.hoisted(() => ({ viewer: null as null | Record<string, unknown> }));
vi.mock("@/lib/auth/current", () => {
  const requireViewer = async () => ({ user: { id: (mocks.viewer as { userId: string }).userId, githubId: 1n, login: "x", name: "X" }, viewer: mocks.viewer, csrf: "x" });
  return { requireViewer, requireWriter: requireViewer };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {}, refresh: () => {} }), redirect: () => {}, unstable_rethrow: () => {} }));

/**
 * Request paths driven as a viewer of the SECOND workspace, with a first workspace holding the same kinds of rows: the first
 * workspace's rows must be untouched, and paths that cannot be made per-workspace must fail closed.
 */

type W = { ws: string; viewer: Viewer; admin: Viewer; userId: string; projectId: string; columnId: string; epicId: string; milestoneId: string; mappingId: string; memberId: string };
let db: Db;
let A: W;
let B: W;

async function world(name: string, githubId: bigint, role: "ADMIN" | "MEMBER" = "ADMIN"): Promise<W> {
  const ws = await db.workspace.create({ data: { name } });
  const user = await db.user.create({ data: { githubId, login: name } });
  const member = await db.member.create({ data: { workspaceId: ws.id, userId: user.id, role } });
  const owner = await db.githubOwner.upsert({ where: { githubId: 9000n }, create: { githubId: 9000n, login: "acme", type: "ORGANIZATION" }, update: {} });
  const mk = (n: number, nm: string) => db.repository.create({ data: { workspaceId: ws.id, githubId: BigInt(n), ownerId: owner.id, name: nm, fullName: `acme/${nm}`, htmlUrl: `https://github.com/acme/${nm}`, visibility: "PRIVATE", defaultBranch: "main" } });
  const fork = await mk(100, "fork");
  const up = await mk(101, "up");
  const mapping = await db.forkMapping.create({ data: { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: "main", upstreamBranch: "main" } });
  const project = await db.project.create({ data: { workspaceId: ws.id, name: "Atlas", slug: "atlas" } });
  await createColumnsForProject(db, project.id);
  await db.projectMember.create({ data: { projectId: project.id, memberId: member.id } });
  const column = await db.planningColumn.findFirstOrThrow({ where: { projectId: project.id, key: "ready" } });
  const epic = await db.epic.create({ data: { projectId: project.id, title: "Epic" } });
  const milestone = await db.dashboardMilestone.create({ data: { workspaceId: ws.id, name: "Beta" } });
  const viewer = (await loadViewer(db, user.id, ws.id))!;
  await createTask(db, viewer, { projectId: project.id, title: `task of ${name}` });
  return { ws: ws.id, viewer, admin: viewer, userId: user.id, projectId: project.id, columnId: column.id, epicId: epic.id, milestoneId: milestone.id, mappingId: mapping.id, memberId: member.id };
}

beforeEach(async () => {
  db = testDb();
  await truncateAll(db);
  A = await world("alpha", 1n);
  B = await world("beta", 2n);
});

describe("fan-out jobs", () => {
  it("one failing workspace does not starve the others, and the job only fails when all fail", async () => {
    const seen: string[] = [];
    const first = (await db.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } }))[0].id;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await forEachWorkspace(db, "test", async (id) => {
      seen.push(id);
      if (id === first) throw new Error("tenant one is broken");
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(first); // fixed order: by id
    await expect(forEachWorkspace(db, "test", async () => { throw new Error("all broken"); })).rejects.toThrow("all broken");
    quiet.mockRestore();
  });

});

describe("restoring a backup whose rows point into another workspace", () => {
  it("skips rows with a foreign mapping, column, epic, iteration or milestone and writes nothing", async () => {
    const b = parseBackup(await exportBackup(db, A.admin));
    const card = b.tables.PlanningItem[0];
    const at = new Date();
    b.tables.PlanningItem.push(
      { ...card, id: "evil-col", columnId: B.columnId },
      { ...card, id: "evil-epic", epicId: B.epicId },
      { ...card, id: "evil-ms", milestoneId: B.milestoneId },
      { ...card, id: "evil-iter", iterationId: "not-mine" },
    );
    b.tables.UpstreamIssueTriage = [{ id: "evil-triage", mappingId: B.mappingId, issueNumber: 1, title: "t", htmlUrl: "https://x", status: "UNTRIAGED", note: null, linkedWorkItemId: null, decidedById: null, updatedAt: at }];
    b.tables.BackportRecord = [{ id: "evil-backport", mappingId: B.mappingId, upstreamNumber: 1, targetBranch: "main", state: "planned", evidence: "unknown", createdAt: at, updatedAt: at }];
    await restoreBackup(db, A.admin, b, { confirmed: true });
    expect(await db.planningItem.count({ where: { id: { startsWith: "evil-" } } })).toBe(0);
    expect(await db.upstreamIssueTriage.count({ where: { id: "evil-triage" } })).toBe(0);
    expect(await db.backportRecord.count({ where: { id: "evil-backport" } })).toBe(0);
  });

  it("still restores a row whose parents are its own workspace's", async () => {
    const b = parseBackup(await exportBackup(db, A.admin));
    const card = b.tables.PlanningItem[0];
    b.tables.PlanningItem.push({ ...card, id: "fine-card", epicId: A.epicId, milestoneId: A.milestoneId, title: "legit" });
    await restoreBackup(db, A.admin, b, { confirmed: true });
    expect(await db.planningItem.count({ where: { id: "fine-card", project: { workspaceId: A.ws } } })).toBe(1);
  });
});
