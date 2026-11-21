import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { loadViewer, repoWhere, requireRepo, requireWorkItem, visibleRepoIds, type Viewer } from "@/lib/authz/viewer";
import { NotFoundError } from "@/lib/errors";
import { createColumnsForProject } from "@/lib/services/planning";
import { attention, derivedDetail, derivedOpen, getWorkItemDetail, listNotifications, listProjects, listRepositories, listWorkItems, overview, planningWhere, recentActivity, searchGlobal, unreadNotificationCount } from "@/lib/services/queries";
import { inbox } from "@/lib/services/inbox";
import { buildDigest } from "@/lib/services/digest";
import { buildSnapshot } from "@/lib/services/ai-review";
import { listPending, pendingCount } from "@/lib/services/ai-approvals";
import { planningBoard } from "@/lib/services/planning-view";
import { assigneeCandidates, listTasks } from "@/lib/services/tasks";
import { exportBackup } from "@/lib/services/backup";
import { boardDto, listProjectsDto, tasksDto } from "@/lib/federation/read-api";
import { ValidationError } from "@/lib/errors";

/**
 * SECURITY. An installation token reads everything the installation can access, so what a person may see is decided by Mergeport:
 * a PRIVATE repository is visible only to the owner and administrators and to people with an explicit grant (repoWhere). Every
 * consumer below must honour it for a member or reader without a grant, and an email user who happens to be named like a GitHub
 * login must never inherit that login's reviews.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
let gid = 1000;
const db = () => state.db!;
beforeEach(() => {
  state.db = createTestPrisma(`github-hosted-visibility-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});

const SECRET = "Secret PR rotate payroll keys";
const NOW = new Date("2026-11-10T12:00:00Z");

async function world() {
  const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
  const admin = await addMember(db(), w.ws.id, "admin@acme.test", "ADMIN");
  // "dev" is a GitHub-linked member who wrote the private pull request; "reader" and "plain" have no grant on it.
  const devUser = await person(db(), "dev@acme.test", { githubId: 1001n });
  const dev = { user: devUser, member: await db().member.create({ data: { workspaceId: w.ws.id, userId: devUser.id, role: "MEMBER", status: "ACTIVE" } }) };
  const plain = await addMember(db(), w.ws.id, "plain@acme.test", "MEMBER");
  const reader = await addMember(db(), w.ws.id, "reader@acme.test", "READER");
  const granted = await addMember(db(), w.ws.id, "granted@acme.test", "MEMBER");

  const owner = await db().githubOwner.create({ data: { githubId: 500n, login: "acme", type: "ORGANIZATION" } });
  const mkRepo = (githubId: bigint, name: string, visibility: "PUBLIC" | "PRIVATE") =>
    db().repository.create({ data: { workspaceId: w.ws.id, githubId, ownerId: owner.id, name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, visibility, defaultBranch: "main", lastSyncedAt: NOW } });
  const pub = await mkRepo(1n, "pub", "PUBLIC");
  const priv = await mkRepo(2n, "payroll-private", "PRIVATE");

  const grant = (memberId: string, repositoryId: string) => db().repositoryGrant.create({ data: { memberId, repositoryId, grantedById: w.owner.id, canManageWork: true, canReview: true } });
  for (const m of [dev.member, plain.member, reader.member, granted.member]) await grant(m.id, pub.id);
  await grant(granted.member.id, priv.id);
  await grant(dev.member.id, priv.id); // dev wrote the private PR and may see it; the others may not

  const item = (repositoryId: string, number: number, o: Record<string, unknown>) =>
    db().workItem.create({ data: { repositoryId, githubId: BigInt(++gid), number, type: "ISSUE", title: `item ${number}`, htmlUrl: `https://github.com/x/${number}`, createdAtGh: new Date(NOW.getTime() - 3 * 86_400_000), updatedAtGh: new Date(NOW.getTime() - 86_400_000), state: "OPEN", ...o } as never });
  const pubPr = await item(pub.id, 1, { type: "PULL_REQUEST", title: "Public docs fix", authorLogin: "someone", headSha: "a1" });
  const secretPr = await item(priv.id, 1, { type: "PULL_REQUEST", title: SECRET, body: "SECRET-BODY", authorLogin: "dev", assignees: ["dev"], assigneeLogins: "|dev|", headSha: "b2", checksState: "FAILURE", mergeable: "CONFLICTING" });
  const secretIssue = await item(priv.id, 2, { title: "Secret issue about layoffs", authorLogin: "dev" });
  for (const wi of [pubPr, secretPr]) {
    await db().reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: "alice", requestedAt: new Date(NOW.getTime() - 5 * 86_400_000) } });
    await db().reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: "carol", requestedAt: new Date(NOW.getTime() - 5 * 86_400_000) } });
  }
  await db().workItemComment.create({ data: { workItemId: secretPr.id, githubId: 9n, kind: "ISSUE_COMMENT", authorLogin: "dev", body: "SECRET-COMMENT", createdAtGh: new Date(NOW.getTime() - 3600_000), updatedAtGh: new Date(NOW.getTime() - 3600_000) } });
  await db().workItemComment.create({ data: { workItemId: secretPr.id, githubId: 10n, kind: "REVIEW", authorLogin: "dev", reviewState: "COMMENTED", body: "", createdAtGh: new Date(NOW.getTime() - 3600_000), updatedAtGh: new Date(NOW.getTime() - 3600_000) } });

  // A project that links both repositories, and a card for each pull request.
  const project = await db().project.create({ data: { workspaceId: w.ws.id, name: "Platform", slug: "platform" } });
  await createColumnsForProject(db(), project.id);
  const col = await db().planningColumn.findFirstOrThrow({ where: { projectId: project.id, key: "ready" } });
  for (const r of [pub, priv]) await db().projectRepository.create({ data: { projectId: project.id, repositoryId: r.id } });
  for (const m of [dev.member, plain.member, reader.member, granted.member, admin.member]) await db().projectMember.create({ data: { projectId: project.id, memberId: m.id } });
  const card = (workItemId: string | null, title: string, position: number) => db().planningItem.create({ data: { projectId: project.id, columnId: col.id, position, title, workItemId, createdById: w.viewer.memberId } });
  await card(pubPr.id, "pub card", 1);
  await card(secretPr.id, "secret card", 2);
  await card(null, "plain draft card", 3);

  for (const u of [plain.user, dev.user, granted.user]) {
    await db().notification.create({ data: { workspaceId: w.ws.id, userId: u.id, repositoryId: priv.id, kind: "review-requested", title: `Review requested: ${SECRET}`, href: `/pull-requests/${secretPr.id}` } });
    await db().notification.create({ data: { workspaceId: w.ws.id, userId: u.id, repositoryId: pub.id, kind: "review-requested", title: "Review requested: Public docs fix", href: `/pull-requests/${pubPr.id}` } });
  }
  await db().aiPendingAction.create({ data: { workspaceId: w.ws.id, kind: "comment", workItemId: secretPr.id, summary: `Comment on acme/payroll-private#1`, payload: { body: "SECRET-DRAFT" } as never } });

  const as = async (userId: string) => (await loadViewer(db(), userId, w.ws.id))! as Viewer;
  return { w, admin, dev, plain, reader, granted, pub, priv, pubPr, secretPr, secretIssue, project, as, viewers: { owner: w.viewer, admin: await admin.viewer(), dev: await as(dev.user.id), plain: await plain.viewer(), reader: await reader.viewer(), granted: await granted.viewer() } };
}

const HIDDEN = [SECRET, "SECRET-BODY", "SECRET-COMMENT", "Secret issue about layoffs", "payroll-private", "secret card", "SECRET-DRAFT"];
const leaks = (value: unknown, needles = HIDDEN) => {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return needles.filter((x) => text.includes(x));
};

describe("repoWhere: the rule", () => {
  it("owner and administrators see every tracked repository; a member or reader sees one only through an explicit grant, public or private", async () => {
    const x = await world();
    const names = async (v: Viewer) => (await db().repository.findMany({ where: repoWhere(v), orderBy: { name: "asc" } })).map((r) => r.name);
    expect(await names(x.viewers.owner)).toEqual(["payroll-private", "pub"]);
    expect(await names(x.viewers.admin)).toEqual(["payroll-private", "pub"]);
    expect(await names(x.viewers.granted)).toEqual(["payroll-private", "pub"]);
    expect(await names(x.viewers.plain)).toEqual(["pub"]);
    expect(await names(x.viewers.reader)).toEqual(["pub"]);
    // Revoking a grant, or untracking, takes effect at once.
    await db().repositoryGrant.updateMany({ where: { memberId: x.granted.member.id, repositoryId: x.priv.id }, data: { revokedAt: new Date() } });
    expect(await names(x.viewers.granted)).toEqual(["pub"]);
    await db().repository.update({ where: { id: x.pub.id }, data: { trackingStatus: "REMOVED" } });
    expect(await names(x.viewers.admin)).toEqual(["payroll-private"]);
    expect(await visibleRepoIds(db(), x.viewers.plain)).toEqual([]);
  });
});

describe("every consumer hides a private repository from a member and a reader without a grant", () => {
  for (const who of ["plain", "reader"] as const) {
    it(`lists, search, counts, queues, inbox, digest, AI, notifications, activity and planning (${who})`, async () => {
      const x = await world();
      const v = x.viewers[who];
      const seen: Record<string, unknown> = {};
      seen.workItems = await listWorkItems(db(), v, { state: "ALL" });
      seen.search = await Promise.all([searchGlobal(db(), v, "Secret"), searchGlobal(db(), v, "payroll"), searchGlobal(db(), v, "layoffs")]);
      seen.repos = await listRepositories(db(), v);
      seen.overview = await overview(db(), v, NOW);
      seen.queues = await attention(db(), v, { now: NOW });
      seen.open = await derivedOpen(db(), v, { now: NOW });
      seen.inbox = await inbox(db(), v, { now: NOW });
      seen.activity = await recentActivity(db(), v);
      seen.notifications = [await listNotifications(db(), v), await unreadNotificationCount(db(), v)];
      seen.projects = await listProjects(db(), v);
      seen.board = await planningBoard(db(), v, x.project.id, NOW);
      seen.tasks = await listTasks(db(), v, {});
      seen.people = await assigneeCandidates(db(), v, x.project.id);
      seen.pending = [await listPending(db(), v, NOW), await pendingCount(db(), v, NOW)];
      seen.ai = (await buildSnapshot(db(), v, NOW)).text;
      seen.digest = await buildDigest(db(), v, { now: NOW, day: "2026-11-09" });
      for (const [k, val] of Object.entries(seen)) expect(leaks(val), `${k} must not leak`).toEqual([]);
      // Counts agree with what is visible: one public pull request, nothing from the private repository.
      expect((seen.overview as { openPrs: number; openIssues: number }).openPrs).toBe(1);
      expect((seen.overview as { openIssues: number }).openIssues).toBe(0);
      expect((seen.projects as { repoCount: number }[])[0].repoCount).toBe(1);
      expect(seen.pending).toEqual([[], 0]);
      expect((await db().planningItem.count({ where: await planningWhere(db(), v) }))).toBe(2); // the public card and the draft card
    });

    it(`direct ids are not found, not forbidden (${who})`, async () => {
      const x = await world();
      const v = x.viewers[who];
      await expect(requireRepo(db(), v, x.priv.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(requireWorkItem(db(), v, x.secretPr.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getWorkItemDetail(db(), v, x.secretIssue.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(derivedDetail(db(), v, x.secretPr.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  }

  it("the JSON routes answer 404 for a pull request the caller cannot see, and 200 with a grant", async () => {
    const x = await world();
    const { GET } = await import("@/app/api/pr/[id]/threads/route");
    const call = async (userId: string) => {
      const { token } = await createSession(db(), userId, new Date(), x.w.ws.id);
      state.jar.set(SESSION_COOKIE, { value: token, options: {} });
      return GET(new Request(`${ORIGIN}/api/pr/${x.secretPr.id}/threads`, { headers: { host: HOST } }), { params: Promise.resolve({ id: x.secretPr.id }) });
    };
    expect((await call(x.plain.user.id)).status).toBe(404);
    expect((await call(x.reader.user.id)).status).toBe(404);
    expect((await call(x.granted.user.id)).status).toBe(200);
    expect((await call(x.admin.user.id)).status).toBe(200);
  });

  it("the search page of the same viewer finds the public pull request but never the private one", async () => {
    const x = await world();
    const r = await searchGlobal(db(), x.viewers.plain, "Public docs");
    expect(r.workItems.map((i) => i.title)).toEqual(["Public docs fix"]);
  });
});

describe("owner, administrators and people with a grant do see it", () => {
  for (const who of ["owner", "admin", "granted", "dev"] as const) {
    it(`${who} sees the private repository, its items, search hits and its card`, async () => {
      const x = await world();
      const v = x.viewers[who];
      const list = await listWorkItems(db(), v, { state: "ALL" });
      expect(list.rows.map((r) => r.title)).toContain(SECRET);
      expect((await searchGlobal(db(), v, "Secret")).workItems.length).toBeGreaterThan(0);
      expect((await listRepositories(db(), v)).map((r) => r.fullName)).toContain("acme/payroll-private");
      expect((await getWorkItemDetail(db(), v, x.secretPr.id)).title).toBe(SECRET);
      expect((await db().planningItem.count({ where: await planningWhere(db(), v) }))).toBe(3);
    });
  }

  it("the person who wrote the private pull request finds it in their digest (and a person without access never does)", async () => {
    const x = await world();
    const mine = JSON.stringify(await buildDigest(db(), x.viewers.dev, { now: NOW, day: "2026-11-09" }));
    expect(mine).toContain(SECRET);
    expect(leaks(await buildDigest(db(), x.viewers.plain, { now: NOW, day: "2026-11-09" }))).toEqual([]);
  });

  it("a pending AI request about the private pull request is listed to people who may see it, and to nobody else", async () => {
    const x = await world();
    expect((await listPending(db(), x.viewers.granted, NOW)).length).toBe(1);
    expect(await pendingCount(db(), x.viewers.granted, NOW)).toBe(1);
    expect(await pendingCount(db(), x.viewers.plain, NOW)).toBe(0);
  });
});

describe("federation and backup", () => {
  it("a federation grant is read as the grant's person: a member without a grant gets no card of the private repository", async () => {
    const x = await world();
    const board = (await boardDto(db(), x.viewers.plain, x.project.id)).columns.flatMap((c) => c.items.map((i) => i.title));
    expect(board.sort()).toEqual(["Public docs fix", "plain draft card"].sort());
    expect(leaks(await tasksDto(db(), x.viewers.plain, x.project.id, { limit: 50, cursor: null }))).toEqual([]);
    expect(leaks(await listProjectsDto(db(), x.viewers.plain, { limit: 50, cursor: null }))).toEqual([]);
    const adminBoard = (await boardDto(db(), x.viewers.admin, x.project.id)).columns.flatMap((c) => c.items.map((i) => i.title));
    expect(adminBoard).toContain(SECRET);
  });

  it("only an administrator exports a backup, and a backup holds no pull request, issue, comment or body from GitHub", async () => {
    const x = await world();
    await expect(exportBackup(db(), x.viewers.plain, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(exportBackup(db(), x.viewers.granted, NOW)).rejects.toBeInstanceOf(ValidationError);
    const text = await exportBackup(db(), x.viewers.admin, NOW);
    expect(leaks(text, [SECRET, "SECRET-BODY", "SECRET-COMMENT", "Secret issue about layoffs", "SECRET-DRAFT"])).toEqual([]);
  });
});

describe("a name is not a GitHub identity", () => {
  it("an email user named like a GitHub login does not get that login's reviews; a linked user does", async () => {
    const x = await world();
    // alice signed in by email: her `login` is the mailbox name, which equals the reviewer on GitHub. She has grants on both repositories.
    const alice = await addMember(db(), x.w.ws.id, "alice@elsewhere.test", "MEMBER");
    const carolUser = await person(db(), "carol@acme.test", { githubId: 2002n });
    const carolMember = await db().member.create({ data: { workspaceId: x.w.ws.id, userId: carolUser.id, role: "MEMBER", status: "ACTIVE" } });
    for (const m of [alice.member, carolMember]) for (const r of [x.pub, x.priv]) await db().repositoryGrant.create({ data: { memberId: m.id, repositoryId: r.id, grantedById: x.w.owner.id, canManageWork: true, canReview: true } });
    const va = await alice.viewer();
    const vc = (await loadViewer(db(), carolUser.id, x.w.ws.id))!;
    expect(va.login).toBe("alice");
    expect(va.githubLogin).toBeNull();
    expect(vc.githubLogin).toBe("carol");

    expect((await attention(db(), va, { now: NOW })).needsMyReview).toHaveLength(0);
    expect((await inbox(db(), va, { now: NOW })).entries).toHaveLength(0);
    expect((await buildSnapshot(db(), va, NOW)).text).not.toContain("Waiting for your review");
    expect(JSON.stringify(await buildDigest(db(), va, { now: NOW, day: "2026-11-09" }))).not.toContain("Waiting for your review");

    expect((await attention(db(), vc, { now: NOW })).needsMyReview.map((d) => d.item.number).sort()).toEqual([1, 1]);
    expect((await inbox(db(), vc, { now: NOW })).entries).toHaveLength(2);
  });

  it("an email user is not an 'internal' reviewer just because her mailbox name matches a GitHub login", async () => {
    const x = await world();
    await addMember(db(), x.w.ws.id, "mallory@elsewhere.test", "MEMBER"); // login "mallory", no GitHub account
    const wi = await db().workItem.create({ data: { repositoryId: x.pub.id, githubId: 77n, number: 5, type: "PULL_REQUEST", title: "Needs mallory", htmlUrl: "https://x/5", createdAtGh: NOW, updatedAtGh: NOW, authorLogin: "someone", headSha: "c3" } });
    await db().reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: "mallory", requestedAt: NOW } });
    const q = await attention(db(), x.viewers.owner, { now: NOW });
    const d = [...q.needsTeamReview, ...q.waitingExternal].find((e) => e.item.id === wi.id)!;
    expect(d.derivation.actors.find((a) => a.actor.ref === "mallory")?.external).toBe(true);
  });

  it("the GitHub login of the viewer is null without a linked account and the login with one", async () => {
    const x = await world();
    expect(x.viewers.owner.githubLogin).toBeNull();
    expect(x.viewers.plain.githubLogin).toBeNull();
    expect(x.viewers.dev.githubLogin).toBe("dev");
  });
});
