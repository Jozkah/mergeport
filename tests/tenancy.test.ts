import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { WORKSPACE_COOKIE, resolveActiveWorkspaceId } from "@/lib/authz/active-workspace";
import { loadViewer, requireProject, requireRepo, requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";
import { aiEnabled, getAiView } from "@/lib/services/ai";
import { approve, listPending, pendingCount, reject, status } from "@/lib/services/ai-approvals";
import { acceptSuggestions, dismissSuggestions, listSuggestions } from "@/lib/services/ai-review";
import { exportBackup, parseBackup, restoreBackup } from "@/lib/services/backup";
import { digestVisibilityKey, getDigest } from "@/lib/services/digest";
import { gettingStarted } from "@/lib/services/getting-started";
import { createColumnsForProject } from "@/lib/services/planning";
import { planningBoard, roadmap } from "@/lib/services/planning-view";
import { getWorkItemDetail, listNotifications, listProjects, listRepositories, listWorkItems, searchGlobal, unreadNotificationCount } from "@/lib/services/queries";
import { createTask, deleteTask, listTasks, loadTask, taskCounts, updateTask } from "@/lib/services/tasks";
import { createTestPrisma } from "./pg";

/**
 * Two workspaces in ONE database, with the same names everywhere (repository acme/api, project Atlas, work item titles, task
 * titles). Every list, search and count must return only the active workspace's rows, and another workspace's ids must give the
 * same "not found" a missing id gives (never a Forbidden that would confirm the id exists).
 */

type World = {
  ws: string;
  viewer: Viewer;
  userId: string;
  repoId: string;
  projectId: string;
  prId: string;
  issueId: string;
  taskId: string;
  suggestionId: string;
  pendingId: string;
  milestoneId: string;
};

let db: Db;
let w1: World;
let w2: World;
let carolId: string;

async function world(name: string, githubId: bigint, login: string): Promise<World> {
  const ws = await db.workspace.create({ data: { name: `${name} workspace` } });
  const user = await db.user.create({ data: { githubId, login } });
  const member = await db.member.create({ data: { workspaceId: ws.id, userId: user.id, role: "ADMIN" } });
  const owner = await db.githubOwner.upsert({ where: { githubId: 9000n }, create: { githubId: 9000n, login: "acme", type: "ORGANIZATION" }, update: {} });
  // The SAME GitHub repository id and name in both workspaces: (workspaceId, githubId) is the identity, not githubId.
  const repo = await db.repository.create({ data: { workspaceId: ws.id, githubId: 100n, ownerId: owner.id, name: "api", fullName: "acme/api", htmlUrl: "https://github.com/acme/api", visibility: "PRIVATE", defaultBranch: "main" } });
  const project = await db.project.create({ data: { workspaceId: ws.id, name: "Atlas", slug: "atlas" } });
  await createColumnsForProject(db, project.id);
  await db.projectRepository.create({ data: { projectId: project.id, repositoryId: repo.id } });
  await db.projectMember.create({ data: { projectId: project.id, memberId: member.id } });
  const at = new Date("2026-10-01T00:00:00Z");
  const pr = await db.workItem.create({ data: { repositoryId: repo.id, githubId: 5001n, number: 1, type: "PULL_REQUEST", title: "Fix login", htmlUrl: "https://github.com/acme/api/pull/1", createdAtGh: at, updatedAtGh: at } });
  const issue = await db.workItem.create({ data: { repositoryId: repo.id, githubId: 5002n, number: 2, type: "ISSUE", title: "Fix login", htmlUrl: "https://github.com/acme/api/issues/2", createdAtGh: at, updatedAtGh: at } });
  const viewer = (await loadViewer(db, user.id, ws.id))!;
  const task = await createTask(db, viewer, { projectId: project.id, title: "Ship it", assigneeLogin: login });
  await db.aiSettings.create({ data: { workspaceId: ws.id, baseUrl: `https://ai.${name}.example/v1` } });
  const suggestion = await db.aiSuggestion.create({ data: { workspaceId: ws.id, sourceKey: "same-key", title: `Suggestion of ${name}`, reason: "because", payload: { href: "/x" } } });
  const pending = await db.aiPendingAction.create({ data: { workspaceId: ws.id, kind: "comment", workItemId: pr.id, summary: `Comment of ${name}`, payload: { body: "hi" } } });
  const milestone = await db.dashboardMilestone.create({ data: { workspaceId: ws.id, name: "Beta" } });
  await db.notification.create({ data: { workspaceId: ws.id, userId: user.id, kind: "review-requested", title: "Look at this", href: `/pull-requests/${pr.id}` } });
  await db.gitCache.create({ data: { workspaceId: ws.id, key: "same-key", payload: { from: name }, bytes: 10 } });
  await db.discoveryCache.create({ data: { workspaceId: ws.id, key: "repos", payload: { from: name }, state: "FRESH" } });
  await db.reviewRule.create({ data: { workspaceId: ws.id, scope: "WORKSPACE", labels: [], reviewers: [], reason: "same rule" } });
  await db.dailyDigest.create({ data: { workspaceId: ws.id, userId: user.id, day: "2026-10-31", payload: { version: 1, of: name }, visibilityKey: await digestVisibilityKey(db, viewer) } });
  return { ws: ws.id, viewer, userId: user.id, repoId: repo.id, projectId: project.id, prId: pr.id, issueId: issue.id, taskId: task.id, suggestionId: suggestion.id, pendingId: pending.id, milestoneId: milestone.id };
}

beforeAll(async () => {
  db = createTestPrisma("tenancy-two-workspaces");
  w1 = await world("one", 11n, "alice");
  w2 = await world("two", 22n, "bob");
  // Carol belongs to BOTH workspaces (oldest membership: one).
  const carol = await db.user.create({ data: { githubId: 33n, login: "carol" } });
  carolId = carol.id;
  await db.member.create({ data: { workspaceId: w1.ws, userId: carol.id, role: "MEMBER" } });
  await db.member.create({ data: { workspaceId: w2.ws, userId: carol.id, role: "MEMBER" } });
});
afterAll(() => db.$disconnect());

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("the active workspace", () => {
  it("loadViewer needs the active workspace when a user has several memberships, and the user must be a member of it", async () => {
    expect(await loadViewer(db, carolId)).toBeNull(); // ambiguous: no guess
    expect((await loadViewer(db, carolId, w2.ws))?.workspaceId).toBe(w2.ws);
    expect((await loadViewer(db, w1.userId))?.workspaceId).toBe(w1.ws); // exactly one membership: the single-workspace fallback
    expect(await loadViewer(db, w1.userId, w2.ws)).toBeNull(); // alice is not a member of two
    expect(await loadViewer(db, w1.userId, "nope")).toBeNull();
  });

  it("resolveActiveWorkspaceId: one membership wins over any cookie; several use the mp_ws cookie only if it is a membership, else the oldest", async () => {
    expect(WORKSPACE_COOKIE).toBe("mp_ws");
    expect(await resolveActiveWorkspaceId(db, { id: w1.userId }, w2.ws)).toBe(w1.ws); // a cookie for a workspace you are not in is ignored
    expect(await resolveActiveWorkspaceId(db, { id: carolId })).toBe(w1.ws);
    expect(await resolveActiveWorkspaceId(db, { id: carolId }, w2.ws)).toBe(w2.ws);
    expect(await resolveActiveWorkspaceId(db, { id: carolId }, "not-a-workspace")).toBe(w1.ws);
    const stranger = await db.user.create({ data: { githubId: 44n, login: "dave" } });
    expect(await resolveActiveWorkspaceId(db, stranger)).toBeNull();
    await db.member.create({ data: { workspaceId: w2.ws, userId: stranger.id, role: "MEMBER", status: "REVOKED" } });
    expect(await resolveActiveWorkspaceId(db, stranger, w2.ws)).toBeNull(); // a revoked membership is not one
  });
});

describe("lists, searches and counts return only the active workspace's rows", () => {
  it("repositories, projects, work items and their search", async () => {
    expect(ids(await listRepositories(db, w1.viewer))).toEqual([w1.repoId]);
    expect(ids(await listRepositories(db, w2.viewer))).toEqual([w2.repoId]);
    expect(ids(await listProjects(db, w1.viewer))).toEqual([w1.projectId]);
    const all = await listWorkItems(db, w1.viewer, { state: "ALL", pageSize: 50 });
    expect(ids(all.rows)).toEqual([w1.issueId, w1.prId].sort());
    const found = await listWorkItems(db, w2.viewer, { state: "ALL", q: "Fix login", pageSize: 50 });
    expect(ids(found.rows)).toEqual([w2.issueId, w2.prId].sort());
    const g = await searchGlobal(db, w1.viewer, "api");
    expect(g.repositories.map((r) => r.id)).toEqual([w1.repoId]);
    const t = await searchGlobal(db, w1.viewer, "Fix login");
    expect(ids(t.workItems)).toEqual([w1.issueId, w1.prId].sort());
    expect((await searchGlobal(db, w2.viewer, "Ship")).planning.map((p) => p.id)).toEqual([w2.taskId]);
  });

  it("tasks, task counts, boards and milestones", async () => {
    expect(ids(await listTasks(db, w1.viewer, { scope: "all" }))).toEqual([w1.taskId]);
    expect(ids(await listTasks(db, w2.viewer, { scope: "all" }))).toEqual([w2.taskId]);
    expect(await taskCounts(db, w1.viewer)).toMatchObject({ all: 1, mine: 1 });
    expect(await taskCounts(db, w2.viewer)).toMatchObject({ all: 1, mine: 1 });
    expect((await planningBoard(db, w1.viewer, w1.projectId)).cards.map((c) => c.id)).toEqual([w1.taskId]);
    expect((await roadmap(db, w1.viewer)).map((m) => m.id)).toEqual([w1.milestoneId]);
    expect((await roadmap(db, w2.viewer)).map((m) => m.id)).toEqual([w2.milestoneId]);
  });

  it("notifications, AI suggestions and requests, AI settings, digests, sync centre, onboarding", async () => {
    expect(await unreadNotificationCount(db, w1.viewer)).toBe(1);
    expect((await listNotifications(db, w2.viewer)).map((n) => n.userId)).toEqual([w2.userId]);
    expect((await listSuggestions(db, w1.viewer)).map((s) => s.id)).toEqual([w1.suggestionId]);
    expect((await listPending(db, w2.viewer)).map((p) => p.id)).toEqual([w2.pendingId]);
    expect(await pendingCount(db, w1.viewer)).toBe(1);
    expect((await getAiView(db, w1.ws)).baseUrl).toBe("https://ai.one.example/v1");
    expect((await getAiView(db, w2.ws)).baseUrl).toBe("https://ai.two.example/v1");
    expect(await aiEnabled(db, w1.ws)).toBe(false); // demo-mode env in tests: AI is off, whatever the row says
    expect((await getAiView(db, (await db.workspace.create({ data: { name: "empty" } })).id)).saved).toBe(false);
    expect((await getDigest(db, w1.viewer, "2026-10-31"))?.payload).toMatchObject({ of: "one" });
    expect(await getDigest(db, { ...w1.viewer, workspaceId: w2.ws }, "2026-10-31")).toBeNull();
    const steps = await gettingStarted(db, w1.viewer);
    expect(steps.find((s) => s.key === "repos")?.done).toBe(true);
  });

  it("a backup holds only its own workspace", async () => {
    const b = parseBackup(await exportBackup(db, w1.viewer));
    expect(b.source.workspaceId).toBe(w1.ws);
    expect(b.repositories.map((r) => r.id)).toEqual([w1.repoId]);
    expect(b.tables.Project.map((p) => p.id)).toEqual([w1.projectId]);
    expect(b.tables.PlanningItem.map((p) => p.id)).toEqual([w1.taskId]);
    expect(b.tables.DashboardMilestone.map((p) => p.id)).toEqual([w1.milestoneId]);
    expect(JSON.stringify(b)).not.toContain(w2.projectId);
    expect(JSON.stringify(b)).not.toContain(w2.taskId);
  });
});

describe("another workspace's ids give the existing non-leaking not-found", () => {
  it("reads", async () => {
    await expect(requireRepo(db, w1.viewer, w2.repoId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireWorkItem(db, w1.viewer, w2.prId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireProject(db, w1.viewer, w2.projectId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getWorkItemDetail(db, w1.viewer, w2.issueId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadTask(db, w1.viewer, w2.taskId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(planningBoard(db, w1.viewer, w2.projectId)).rejects.toBeInstanceOf(NotFoundError);
    // the same answer as an id that does not exist at all
    await expect(requireRepo(db, w1.viewer, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes change nothing", async () => {
    await expect(deleteTask(db, w1.viewer, w2.taskId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateTask(db, w1.viewer, w2.taskId, { title: "hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: w2.taskId } })).title).toBe("Ship it");
    expect(await acceptSuggestions(db, w1.viewer, [w2.suggestionId])).toBe(0);
    expect(await dismissSuggestions(db, w1.viewer, [w2.suggestionId])).toBe(0);
    expect((await db.aiSuggestion.findUniqueOrThrow({ where: { id: w2.suggestionId } })).state).toBe("NEW");
    expect(await reject(db, w1.viewer, w2.pendingId)).toBe(false);
    await expect(approve(db, w1.viewer, w2.pendingId)).rejects.toBeInstanceOf(ValidationError);
    await expect(status(db, w1.viewer, w2.pendingId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.aiPendingAction.findUniqueOrThrow({ where: { id: w2.pendingId } })).state).toBe("PENDING");
  });

  it("a crafted backup cannot overwrite or reach into another workspace", async () => {
    const theirs = (await exportBackup(db, w2.viewer)).replaceAll('"Atlas"', '"Hacked"').replaceAll('"Ship it"', '"Hacked task"');
    const preview = await restoreBackup(db, w1.viewer, parseBackup(theirs), { confirmed: true });
    expect(preview.tables.find((t) => t.table === "Project")).toMatchObject({ update: 0, create: 0 });
    expect((await db.project.findUniqueOrThrow({ where: { id: w2.projectId } })).name).toBe("Atlas");
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: w2.taskId } })).title).toBe("Ship it");
    expect(await db.project.count({ where: { workspaceId: w1.ws } })).toBe(1);
  });
});

describe("per-workspace singletons, caches and jobs", () => {
  it("GitCache and DiscoveryCache hold one row per workspace", async () => {
    expect((await db.gitCache.findUniqueOrThrow({ where: { workspaceId_key: { workspaceId: w1.ws, key: "same-key" } } })).payload).toEqual({ from: "one" });
    expect((await db.gitCache.findUniqueOrThrow({ where: { workspaceId_key: { workspaceId: w2.ws, key: "same-key" } } })).payload).toEqual({ from: "two" });
    expect((await db.discoveryCache.findUniqueOrThrow({ where: { workspaceId_key: { workspaceId: w2.ws, key: "repos" } } })).payload).toEqual({ from: "two" });
  });

  it("a job takes the workspace of the repository or mapping it names", async () => {
    const j1 = await enqueue(db, { type: "sync.repository", payload: { repositoryId: w1.repoId }, dedupeKey: `sync:${w1.repoId}` });
    const j2 = await enqueue(db, { type: "sync.repository", payload: { repositoryId: w2.repoId }, dedupeKey: `sync:${w2.repoId}` });
    expect([j1.workspaceId, j2.workspaceId]).toEqual([w1.ws, w2.ws]);
    const system = await enqueue(db, { type: "reconcile.all", payload: {}, dedupeKey: "system-test" });
    expect(system.workspaceId).toBeNull();
    expect(await db.job.count({ where: { workspaceId: w1.ws } })).toBe(1);
  });

  it("deleting a workspace deletes what it owns and nothing else (ON DELETE CASCADE)", async () => {
    const doomed = await world("four", 66n, "frank");
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: doomed.repoId }, dedupeKey: `sync:${doomed.repoId}` });
    await db.workspace.delete({ where: { id: doomed.ws } });
    for (const n of await Promise.all([db.repository.count({ where: { workspaceId: doomed.ws } }), db.project.count({ where: { workspaceId: doomed.ws } }), db.aiSettings.count({ where: { workspaceId: doomed.ws } }), db.aiSuggestion.count({ where: { workspaceId: doomed.ws } }), db.gitCache.count({ where: { workspaceId: doomed.ws } }), db.discoveryCache.count({ where: { workspaceId: doomed.ws } }), db.job.count({ where: { workspaceId: doomed.ws } }), db.dailyDigest.count({ where: { workspaceId: doomed.ws } }), db.reviewRule.count({ where: { workspaceId: doomed.ws } })]))
      expect(n).toBe(0);
    expect(await db.repository.count({ where: { workspaceId: w1.ws } })).toBe(1);
    expect(await db.planningItem.count({ where: { id: doomed.taskId } })).toBe(0);
  });
});
