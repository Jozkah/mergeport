import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { loadViewer, requireRepo, requireWorkItem } from "@/lib/authz/viewer";
import { attention, getWorkItemDetail, listProjects, listRepositories, listWorkItems, overview, searchGlobal } from "@/lib/services/queries";
import { addDependency, createCard, listDependencies, milestoneProgress, moveCard } from "@/lib/services/planning";
import { grantRepositories, revokeRepositories } from "@/lib/services/grants";
import { removeFromTracking } from "@/lib/services/repositories";
import { freshSeed, leaks } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const names = (rs: { fullName: string }[]) => rs.map((r) => r.fullName).sort();

describe("repository visibility", () => {
  it("admin sees every configured repository including a disconnected one; members see only their grants", async () => {
    const { db, admin, a, b } = S;
    const adminRepos = await listRepositories(db, admin);
    expect(adminRepos).toHaveLength(7);
    expect(adminRepos.find((r) => r.name === "legacy-disconnected")?.trackingStatus).toBe("DISCONNECTED");
    expect(names(await listRepositories(db, a))).toEqual(["northwind/atlas-api", "northwind/atlas-web", "owner-demo/dashboard-fork"]);
    expect(names(await listRepositories(db, b))).toEqual(["acme-labs/dashboard-core", "northwind/atlas-web"]);
  });

  it("a public-but-unassigned repository is invisible to members", async () => {
    const { db, a, b, ids } = S;
    for (const v of [a, b]) {
      await expect(requireRepo(db, v, ids.repos.sandbox.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(leaks(await listRepositories(db, v), "public-sandbox")).toBe(false);
    }
  });

  it("two projects for the admin; members see only projects with a visible repo and count only visible repos", async () => {
    const { db, admin, a, b } = S;
    expect((await listProjects(db, admin)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
    const pa = await listProjects(db, a);
    expect(pa.find((p) => p.name === "Dashboard")?.repoCount).toBe(2); // web + fork, not core/internal
    expect(pa.find((p) => p.name === "Atlas")?.repoCount).toBe(2);
    const pb = await listProjects(db, b);
    expect(pb.find((p) => p.name === "Atlas")?.repoCount).toBe(1); // web only
    expect(pb.find((p) => p.name === "Dashboard")?.repoCount).toBe(2); // web + core
  });

  it("a member with no visible repo in a project does not see that project at all", async () => {
    const { db, a, ids } = S;
    await revokeRepositories(db, S.admin, ids.members.a.id, [ids.repos.api.id, ids.repos.web.id]);
    const names = (await listProjects(db, a)).map((p) => p.name);
    expect(names).toEqual(["Dashboard"]); // still has the fork, which lives in Dashboard
  });
});

describe("hidden data never leaks through lists, counts, search, details", () => {
  it("work item lists, search and counts are scoped before aggregation", async () => {
    const { db, admin, a, b } = S;
    for (const v of [a, b]) {
      const all = await listWorkItems(db, v, { state: "ALL", pageSize: 100 });
      expect(leaks(all.rows, "HIDDEN-FROM-MEMBERS")).toBe(false);
      expect(leaks(all.rows, "internal-tools")).toBe(false);
      const s = await searchGlobal(db, v, "HIDDEN");
      expect(s.workItems).toHaveLength(0);
      expect((await searchGlobal(db, v, "internal-tools")).repositories).toHaveLength(0);
    }
    const adminAll = await listWorkItems(db, admin, { state: "ALL", pageSize: 100 });
    const aAll = await listWorkItems(db, a, { state: "ALL", pageSize: 100 });
    expect(adminAll.total).toBeGreaterThan(aAll.total);
    expect((await searchGlobal(db, admin, "HIDDEN")).workItems.length).toBe(3);
  });

  it("totals returned with a page are scoped (no hidden total via pagination metadata)", async () => {
    const { db, a } = S;
    const page = await listWorkItems(db, a, { state: "ALL", pageSize: 1 });
    const full = await listWorkItems(db, a, { state: "ALL", pageSize: 100 });
    expect(page.total).toBe(full.rows.length);
  });

  it("overview counts only include visible work", async () => {
    const { db, admin, a } = S;
    const oa = await overview(db, a, new Date("2026-10-28T12:00:00Z"));
    const oadmin = await overview(db, admin, new Date("2026-10-28T12:00:00Z"));
    expect(oa.openIssues + oa.openPrs).toBeLessThan(oadmin.openIssues + oadmin.openPrs);
    expect(leaks(oa, "HIDDEN")).toBe(false);
  });

  it("direct navigation to a hidden item is indistinguishable from a missing one", async () => {
    const { db, a, ids } = S;
    const hidden = await db.workItem.findFirstOrThrow({ where: { repositoryId: ids.repos.internal.id } });
    const e1 = await getWorkItemDetail(db, a, hidden.id).catch((e) => e);
    const e2 = await getWorkItemDetail(db, a, "does-not-exist").catch((e) => e);
    expect(e1).toBeInstanceOf(NotFoundError);
    expect(e2).toBeInstanceOf(NotFoundError);
    expect(e1.message).toBe(e2.message);
    await expect(requireWorkItem(db, a, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("attention queues never include hidden repositories", async () => {
    const { db, a, b } = S;
    for (const v of [a, b]) {
      const q = await attention(db, v, { now: new Date("2026-10-28T12:00:00Z") });
      expect(leaks(Object.values(q).flat().map((d) => d.item.title), "HIDDEN")).toBe(false);
    }
  });
});

describe("planning scope", () => {
  it("members only see cards for repositories they can see; admin-only linked card is hidden", async () => {
    const { db, a, ids } = S;
    const q = await db.planningItem.findMany({ where: { projectId: ids.projects.dash.id } });
    expect(q.some((c) => c.title.includes("HIDDEN"))).toBe(true); // exists in DB
    const { planningWhere } = await import("@/lib/services/queries");
    const visible = await db.planningItem.findMany({ where: await planningWhere(db, a) });
    expect(visible.some((c) => c.title.includes("HIDDEN"))).toBe(false);
  });

  it("milestone progress is labelled 'Visible work' and counts only visible canonical items", async () => {
    const { db, admin, a, b, ids } = S;
    const pAdmin = await milestoneProgress(db, admin, ids.milestone.id);
    const pA = await milestoneProgress(db, a, ids.milestone.id);
    const pB = await milestoneProgress(db, b, ids.milestone.id);
    expect(pAdmin.progress.total).toBe(5);
    expect(pA.progress.total).toBe(5); // A can see api + web
    expect(pB.progress.total).toBe(3); // B lacks atlas-api: 2 linked PR cards hidden
    expect(pB.progress.label).toBe("Visible work");
    expect(pB.progress.done).toBe(1);
  });

  it("a visible card linked to a hidden one shows an opaque dependency marker, not its title or id", async () => {
    const { db, admin, b, ids } = S;
    // cWeb (visible to B) <- blocked by cApiPr (hidden to B)
    await addDependency(db, admin, ids.cards.cApiPr.id, ids.cards.cWeb.id);
    const deps = await listDependencies(db, b, ids.cards.cWeb.id);
    const opaque = deps.filter((d) => d.opaque);
    expect(opaque).toHaveLength(1);
    expect(leaks(deps, ids.cards.cApiPr.id)).toBe(false);
    expect(leaks(deps, "token refresh")).toBe(false);
  });

  it("rejects dependency cycles", async () => {
    const { db, admin, ids } = S;
    // existing: cApiPr2 blocks cApiPr. Adding cApiPr blocks cApiPr2 must fail.
    await expect(addDependency(db, admin, ids.cards.cApiPr.id, ids.cards.cApiPr2.id)).rejects.toThrow(/cycle/);
  });
});

describe("forged mutations", () => {
  it("members cannot grant themselves repositories", async () => {
    const { db, a, ids } = S;
    await expect(grantRepositories(db, a, ids.members.a.id, [ids.repos.internal.id])).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listRepositories(db, a)).some((r) => r.name === "internal-tools")).toBe(false);
  });

  it("a card cannot reference a hidden work item (forged id), and the error does not confirm it exists", async () => {
    const { db, b, a, ids } = S;
    const forged = await createCard(db, b, { projectId: ids.projects.atlas.id, workItemId: ids.items.api14.id }).catch((e) => e);
    expect(forged).toBeInstanceOf(NotFoundError);
    const hiddenInternal = await db.workItem.findFirstOrThrow({ where: { repositoryId: ids.repos.internal.id } });
    expect(await createCard(db, a, { projectId: ids.projects.dash.id, workItemId: hiddenInternal.id }).catch((e) => e)).toBeInstanceOf(NotFoundError);
  });

  it("a hidden card cannot be moved; a view-only grant cannot move linked cards", async () => {
    const { db, a, b, ids } = S;
    const hiddenCard = await db.planningItem.findFirstOrThrow({ where: { title: { contains: "HIDDEN" } } });
    await expect(moveCard(db, a, { itemId: hiddenCard.id, toColumnKey: "done", expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundError);
    // B can see atlas-web but only has review capability there, not manageWork.
    await expect(moveCard(db, b, { itemId: ids.cards.cWeb.id, toColumnKey: "done", expectedVersion: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moveCard(db, a, { itemId: ids.cards.cWeb.id, toColumnKey: "done", expectedVersion: 1 })).resolves.toBeTruthy();
  });

  it("another project's repository cannot be attached to a card", async () => {
    const { db, a, ids } = S;
    // atlas-api is in Atlas only; Dashboard project must refuse it.
    await expect(createCard(db, a, { projectId: ids.projects.dash.id, workItemId: ids.items.api14.id })).rejects.toThrow(/not part of this project/);
  });
});

describe("revocation takes effect immediately", () => {
  it("grant revocation: next request denies, no cached viewer state", async () => {
    const { db, a, admin, ids } = S;
    expect((await listWorkItems(db, a, { state: "ALL", repositoryIds: [ids.repos.web.id], pageSize: 100 })).rows.length).toBeGreaterThan(0);
    await revokeRepositories(db, admin, ids.members.a.id, [ids.repos.web.id]);
    expect((await listWorkItems(db, a, { state: "ALL", repositoryIds: [ids.repos.web.id], pageSize: 100 })).rows).toHaveLength(0); // same Viewer object, fresh decision
    await expect(requireRepo(db, a, ids.repos.web.id)).rejects.toBeInstanceOf(NotFoundError);
    const detail = await db.workItem.findFirstOrThrow({ where: { repositoryId: ids.repos.web.id } });
    await expect(getWorkItemDetail(db, a, detail.id)).rejects.toBeInstanceOf(NotFoundError);
    const m = await milestoneProgress(db, a, ids.milestone.id);
    expect(m.progress.total).toBe(4); // web7 card disappeared from visible work
  });

  it("untracking a repository revokes access at once and drops its local worktree data", async () => {
    const { db, admin, a, ids } = S;
    const dev = await db.device.create({ data: { userId: ids.users.a.id, name: "This computer" } });
    await db.worktreeSnapshot.create({ data: { deviceId: dev.id, repositoryId: ids.repos.web.id, capturedAt: new Date(), data: { worktrees: [] } } });
    await removeFromTracking(db, admin, ids.repos.web.id);
    await expect(requireRepo(db, a, ids.repos.web.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.worktreeSnapshot.count({ where: { repositoryId: ids.repos.web.id } })).toBe(0);
    expect(await db.repositoryGrant.count({ where: { repositoryId: ids.repos.web.id, revokedAt: null } })).toBe(0);
    expect(await loadViewer(db, ids.users.a.id)).not.toBeNull(); // the person is still there; only the repository went
  });
});
