import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import { truncateAll } from "@/lib/demo/seed";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { clearCoverage, clearHubCoverage, clearHubWebhooks, readAllCoverage, readHubWebhooksEnabled, saveCoverage, saveHubCoverage, saveHubWebhooks } from "@/lib/hub/github-app-install";
import { clearHubSession, loadHubSession, openVault, saveHubSession } from "@/lib/hub/session-vault";
import { handlers, forEachWorkspace } from "@/lib/local/handlers";
import { readCached, toJson } from "@/lib/local/discovery";
import { firstWorkspace } from "@/lib/local/profile";
import { exportBackup, parseBackup, restoreBackup } from "@/lib/services/backup";
import { createColumnsForProject } from "@/lib/services/planning";
import { createTask } from "@/lib/services/tasks";
import { leaveTeamLocally } from "@/lib/team/leave";
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

type W = { ws: string; viewer: Viewer; admin: Viewer; userId: string; projectId: string; columnId: string; epicId: string; milestoneId: string; mappingId: string; spaceId: string; memberId: string };
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
  const space = await db.space.create({ data: { workspaceId: ws.id, remoteId: `s-${name}`, teamRemoteId: "t", kind: "COMMON", name: "Team", repoOwner: "acme", repoName: `coord-${name}`, canWrite: true } });
  await db.teamConfig.create({ data: { workspaceId: ws.id, mode: "TEAM", teamRemoteId: "t", name: "Team", commonSpaceId: space.id } });
  await db.repository.update({ where: { id: fork.id }, data: { spaceId: space.id } });
  await db.project.update({ where: { id: project.id }, data: { spaceId: space.id } });
  const viewer = (await loadViewer(db, user.id, ws.id))!;
  await createTask(db, viewer, { projectId: project.id, title: `task of ${name}` });
  return { ws: ws.id, viewer, admin: viewer, userId: user.id, projectId: project.id, columnId: column.id, epicId: epic.id, milestoneId: milestone.id, mappingId: mapping.id, spaceId: space.id, memberId: member.id };
}

beforeEach(async () => {
  db = testDb();
  await truncateAll(db);
  A = await world("alpha", 1n);
  B = await world("beta", 2n);
});

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};

describe("leaving a team", () => {
  it("leaveTeamAction as an admin of the second workspace leaves the first workspace's team, spaces and roles alone", async () => {
    await db.member.update({ where: { id: A.memberId }, data: { role: "MEMBER" } }); // the first workspace's person is a team MEMBER there
    mocks.viewer = B.viewer as unknown as Record<string, unknown>;
    const { leaveTeamAction } = await import("@/app/team-actions");
    expect(await leaveTeamAction(fd({ confirm: "on" }))).toMatchObject({ ok: true });
    expect(await db.space.count({ where: { workspaceId: B.ws } })).toBe(0);
    expect((await db.teamConfig.findUniqueOrThrow({ where: { workspaceId: B.ws } })).mode).toBe("PERSONAL");
    expect(await db.space.count({ where: { workspaceId: A.ws } })).toBe(1);
    const a = await db.teamConfig.findUniqueOrThrow({ where: { workspaceId: A.ws } });
    expect(a).toMatchObject({ mode: "TEAM", commonSpaceId: A.spaceId });
    expect((await db.member.findUniqueOrThrow({ where: { id: A.memberId } })).role).toBe("MEMBER");
    expect((await db.project.findUniqueOrThrow({ where: { id: A.projectId } })).spaceId).toBe(A.spaceId);
  });

  it("a plain member of the second workspace cannot leave at all", async () => {
    const m = await db.user.create({ data: { githubId: 77n, login: "plain" } });
    await db.member.create({ data: { workspaceId: B.ws, userId: m.id, role: "MEMBER" } });
    mocks.viewer = (await loadViewer(db, m.id, B.ws)) as unknown as Record<string, unknown>;
    const { leaveTeamAction } = await import("@/app/team-actions");
    expect(await leaveTeamAction(fd({ confirm: "on" }))).toMatchObject({ ok: false });
    expect(await db.space.count()).toBe(2);
  });

  it("leaveTeamLocally needs a workspace", async () => {
    expect(leaveTeamLocally.length).toBe(2);
    await leaveTeamLocally(db, B.ws);
    expect(await db.space.count({ where: { workspaceId: A.ws } })).toBe(1);
  });
});

describe("discovery lists", () => {
  it("the second workspace never reads (or imports) the first workspace's saved GitHub list", async () => {
    const list = toJson({ repos: [{ githubId: 4242n, fullName: "acme/secret-private", name: "secret-private", owner: { githubId: 9000n, login: "acme", type: "ORGANIZATION" }, htmlUrl: "https://github.com/acme/secret-private", visibility: "PRIVATE", defaultBranch: "main", archived: false, isFork: false, description: null }], nextPage: null, notes: [] });
    await db.discoveryCache.create({ data: { workspaceId: A.ws, key: "repos", payload: list, fetchedAt: new Date(), state: "FRESH" } });
    expect((await readCached(db, "repos", new Date(), undefined, A.ws)).payload).not.toBeNull();
    expect((await readCached(db, "repos", new Date(), undefined, B.ws)).payload).toBeNull();
    mocks.viewer = B.viewer as unknown as Record<string, unknown>;
    const { trackSelectedAction } = await import("@/app/actions");
    const r = await trackSelectedAction(fd({ repo: "4242" }));
    expect(r).toMatchObject({ ok: false });
    expect(await db.repository.count({ where: { workspaceId: B.ws, githubId: 4242n } })).toBe(0);
  });

  it("a path with no workspace fails closed when there are several", async () => {
    await expect(readCached(db, "repos")).rejects.toThrow(/one workspace per database/);
    await expect(firstWorkspace(db)).rejects.toThrow(/Pass the workspace explicitly/);
  });
});

describe("hub coverage caches and the hub login", () => {
  it("coverage, webhooks flag and hub session of the second workspace never touch the first's", async () => {
    await saveCoverage(db, { appSlug: "app", checkedAt: new Date().toISOString(), covered: ["1"] }, A.ws);
    await saveHubCoverage(db, ["2"], new Date(), A.ws);
    await saveHubWebhooks(db, true, new Date(), A.ws);
    await saveCoverage(db, { appSlug: "app", checkedAt: new Date().toISOString(), covered: ["9"] }, B.ws);
    expect([...(await readAllCoverage(db, "app", A.ws))].sort()).toEqual(["1", "2"]);
    expect([...(await readAllCoverage(db, "app", B.ws))]).toEqual(["9"]);
    expect(await readHubWebhooksEnabled(db, B.ws)).toBe(false);
    await clearCoverage(db, B.ws);
    await clearHubCoverage(db, B.ws);
    await clearHubWebhooks(db, B.ws);
    expect([...(await readAllCoverage(db, "app", A.ws))].sort()).toEqual(["1", "2"]);
    expect(await readHubWebhooksEnabled(db, A.ws)).toBe(true);
    await expect(clearCoverage(db)).rejects.toThrow(/one workspace per database/); // fail closed, never "the oldest"

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    try {
      const vault = openVault(path.join(dir, "key"));
      await saveHubSession(db, vault, { origin: "https://hub.a", token: "tok-a", githubId: 1n, login: "alpha" }, A.ws);
      expect(await loadHubSession(db, vault, B.ws)).toBeNull();
      await saveHubSession(db, vault, { origin: "https://hub.b", token: "tok-b", githubId: 2n, login: "beta" }, B.ws);
      await clearHubSession(db, B.ws);
      expect((await loadHubSession(db, vault, A.ws))?.token).toBe("tok-a");
      expect(await loadHubSession(db, vault, B.ws)).toBeNull();
      await expect(loadHubSession(db, vault)).rejects.toThrow(/one workspace per database/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
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

  it("reconcile.all queues each workspace's repositories under its own workspace", async () => {
    await handlers["reconcile.all"]({} as never, {} as never);
    const jobs = await db.job.findMany({ where: { type: "sync.repository" } });
    expect(jobs.length).toBe(4);
    for (const w of [A, B]) expect(jobs.filter((j) => j.workspaceId === w.ws)).toHaveLength(2);
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
