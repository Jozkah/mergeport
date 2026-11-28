import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { bind } from "./github-hosted-helpers";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/federation/config";
import { loadViewer, repoWhere, requireRepo, requireWorkItem, capabilitiesFor, visibleRepoIds, type Viewer } from "@/lib/authz/viewer";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { createColumnsForProject } from "@/lib/services/planning";
import { attention, derivedDetail, getWorkItemDetail, listNotifications, listProjects, listRepositories, listWorkItems, overview, searchGlobal, unreadNotificationCount } from "@/lib/services/queries";
import { inbox } from "@/lib/services/inbox";
import { buildDigest } from "@/lib/services/digest";
import { buildSnapshot } from "@/lib/services/ai-review";
import { boardDto, listProjectsDto, tasksDto } from "@/lib/federation/read-api";
import { removeMember } from "@/lib/services/members";
import { ACCESS_JOB, MAX_VIEWER_REPO_IDS, VALID_FOR_MS, REFRESH_AFTER_MS, maybeRequestAccessRefresh, validRepoGithubIds } from "@/lib/github/access-cache";
import { githubAppConfig, resetGithubAppConfigCache } from "@/lib/github/app-config";
import { exchangeCodeForTokens } from "@/lib/github/connect-api";
import { setConnectOverridesForTests } from "@/lib/github/connect";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { refreshUserAccess, userBudgetKey, USER_BUDGET_MAX } from "@/lib/github/user-access";
import { linkGithubAccount, unlinkGithubAccount } from "@/lib/github/user-link";
import { markRelink, markRelinkIfCurrent, tokenAad } from "@/lib/github/user-token";
import { GithubAppError } from "@/lib/github/app-auth";
import { requestAccessRefresh } from "@/lib/github/access-cache";
import { generateDigest, getDigest, latestDigest } from "@/lib/services/digest";
import { refreshForkAction, refreshRepositoryAction } from "@/app/actions";
import { runOne } from "@/lib/jobs";

/**
 * SECURITY, the heart of the per-person GitHub link. What a MEMBER or READER sees of a repository tracked through a GitHub App
 * installation is what GitHub says they can open, checked recently, OR an explicit grant. These tests drive the REAL link and refresh
 * code against the fake GitHub, then check every consumer of repoWhere.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const CLIENT_ID = "Iv1.testclient01";
const CLIENT_SECRET = "client-secret-0123456789-abcdef";
const ENC_KEY = "k".repeat(40);
const REDIRECT = `${ORIGIN}/api/github/link/callback`;
const NOW = new Date("2026-11-10T12:00:00Z");
const PRIV1 = "PRIV1-SECRET pull request";
const PRIV2 = "PRIV2-SECRET pull request";
const PUB = "Public docs fix";

let fake: FakeGitHubServer;
let n = 0;
let gid = 5000;
const db = () => state.db!;
const cfg = () => githubAppConfig()!;
const key = () => Buffer.from(createHash("sha256").update(Buffer.from(ENC_KEY, "utf8")).digest());
let seenAuth: string[] = [];

beforeEach(() => {
  state.db = createTestPrisma(`github-access-${n++}`);
  state.jar.clear();
  seenAuth = [];
  fake = new FakeGitHubServer();
  const app = fake.registerApp("12345");
  fake.setOAuthClient(CLIENT_ID, CLIENT_SECRET);
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", ENC_KEY);
  vi.stubEnv("MERGEPORT_GITHUB_APP_ID", app.appId);
  vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", app.privateKeyPem);
  vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "w".repeat(32));
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "mergeport-test");
  resetGithubAppConfigCache();
  // Every request the refresh makes is recorded with the token it was made with.
  const base = fake.appFetch();
  setConnectOverridesForTests({ deps: { fetch: ((i: RequestInfo | URL, init?: RequestInit) => (seenAuth.push(`${new Headers(init?.headers).get("authorization") ?? ""}|${new URL(String(i)).pathname}`), base(i, init))) as typeof fetch } });
});
afterEach(async () => {
  setConnectOverridesForTests(null);
  vi.unstubAllEnvs();
  resetGithubAppConfigCache();
  await state.db!.$disconnect();
});

async function linkUser(userId: string, workspaceId: string, login: string) {
  const code = fake.issueOAuthCode(login, { redirectUri: REDIRECT });
  const tokens = (await exchangeCodeForTokens(cfg(), { fetch: fake.appFetch() }, { code, redirectUri: REDIRECT }))!;
  const r = await linkGithubAccount(db(), { userId, workspaceId, github: { id: BigInt(fake.users.get(login)!.id), login }, tokens, key: key(), now: new Date() });
  expect(r).toBe("linked");
}
const refresh = (userId: string, now?: Date) => refreshUserAccess(db(), cfg(), userId, { now });
const names = async (v: Viewer) => (await db().repository.findMany({ where: repoWhere(v), orderBy: { name: "asc" } })).map((r) => r.name);
const hidden = [PRIV2, "priv2", "PRIV2-CARD", "PRIV2-COMMENT"];
const leaks = (value: unknown, needles: string[]) => {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return needles.filter((x) => text.includes(x));
};

/**
 * Workspace "Acme" with: an owner, an admin, and members alice (linked to alice-gh, who is a collaborator on priv1), bob (linked to
 * bob-gh, who can open no private repository), carol (no GitHub link, granted `pub` only), dave (a READER linked to dave-gh, a
 * collaborator on priv1). Repositories pub (public), priv1 and priv2 (private) are all tracked through installation `inst`.
 */
async function world() {
  const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
  const admin = await addMember(db(), w.ws.id, "admin@acme.test", "ADMIN");
  const alice = await addMember(db(), w.ws.id, "alice@acme.test", "MEMBER");
  const bob = await addMember(db(), w.ws.id, "bob@acme.test", "MEMBER");
  const carol = await addMember(db(), w.ws.id, "carol@acme.test", "MEMBER");
  const dave = await addMember(db(), w.ws.id, "dave@acme.test", "READER");

  for (const l of ["acme-owner", "alice-gh", "bob-gh", "dave-gh", "eve-gh"]) fake.addUser(l);
  fake.addOrg("acme", ["acme-owner"], ["alice-gh", "bob-gh", "dave-gh", "eve-gh"]);
  const create = async (name: string, isPrivate: boolean) => {
    const r = await fake.fetchFor("acme-owner")("https://api.github.com/orgs/acme/repos", { method: "POST", body: JSON.stringify({ name, private: isPrivate }) });
    return (await r.json()) as { id: number };
  };
  const ghPub = await create("pub", false);
  const ghPriv1 = await create("priv1", true);
  const ghPriv2 = await create("priv2", true);
  fake.repo("acme", "priv1")!.collaborators.set("alice-gh", "pull");
  fake.repo("acme", "priv1")!.collaborators.set("dave-gh", "push");
  const inst = fake.addInstallation("acme", { selection: "all" });
  await bind(db(), w.ws.id, inst);

  const owner = await db().githubOwner.create({ data: { githubId: 500n, login: "acme", type: "ORGANIZATION" } });
  const mkRepo = (githubId: number, name: string, visibility: "PUBLIC" | "PRIVATE", installationId: bigint | null = BigInt(inst.id)) =>
    db().repository.create({ data: { workspaceId: w.ws.id, githubId: BigInt(githubId), ownerId: owner.id, name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, visibility, defaultBranch: "main", lastSyncedAt: NOW, installationId } });
  const pub = await mkRepo(ghPub.id, "pub", "PUBLIC");
  const priv1 = await mkRepo(ghPriv1.id, "priv1", "PRIVATE");
  const priv2 = await mkRepo(ghPriv2.id, "priv2", "PRIVATE");

  const grant = (memberId: string, repositoryId: string) => db().repositoryGrant.create({ data: { memberId, repositoryId, grantedById: w.owner.id, canManageWork: true, canReview: true } });
  await grant(carol.member.id, pub.id);

  const item = (repositoryId: string, number: number, o: Record<string, unknown>) =>
    db().workItem.create({ data: { repositoryId, githubId: BigInt(++gid), number, type: "PULL_REQUEST", title: `item ${number}`, htmlUrl: `https://github.com/x/${number}`, createdAtGh: new Date(NOW.getTime() - 3 * 86_400_000), updatedAtGh: new Date(NOW.getTime() - 86_400_000), state: "OPEN", headSha: `sha${number}`, authorLogin: "someone", ...o } as never });
  const pubPr = await item(pub.id, 1, { title: PUB });
  const priv1Pr = await item(priv1.id, 1, { title: PRIV1 });
  const priv2Pr = await item(priv2.id, 1, { title: PRIV2 });
  for (const wi of [pubPr, priv1Pr, priv2Pr]) await db().reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: "alice-gh", requestedAt: new Date(NOW.getTime() - 5 * 86_400_000) } });
  await db().workItemComment.create({ data: { workItemId: priv2Pr.id, githubId: 9n, kind: "ISSUE_COMMENT", authorLogin: "x", body: "PRIV2-COMMENT", createdAtGh: NOW, updatedAtGh: NOW } });

  const project = await db().project.create({ data: { workspaceId: w.ws.id, name: "Platform", slug: "platform" } });
  await createColumnsForProject(db(), project.id);
  const col = await db().planningColumn.findFirstOrThrow({ where: { projectId: project.id, key: "ready" } });
  for (const r of [pub, priv1, priv2]) await db().projectRepository.create({ data: { projectId: project.id, repositoryId: r.id } });
  for (const m of [alice, bob, carol, dave, admin]) await db().projectMember.create({ data: { projectId: project.id, memberId: m.member.id } });
  let pos = 0;
  const card = (workItemId: string, title: string) => db().planningItem.create({ data: { projectId: project.id, columnId: col.id, position: ++pos, title, workItemId, createdById: w.viewer.memberId } });
  await card(pubPr.id, "PUB-CARD");
  await card(priv1Pr.id, "PRIV1-CARD");
  await card(priv2Pr.id, "PRIV2-CARD");
  for (const u of [alice, bob]) for (const [r, t] of [[pub, "Review requested: " + PUB], [priv1, "Review requested: " + PRIV1], [priv2, "Review requested: " + PRIV2]] as const) await db().notification.create({ data: { workspaceId: w.ws.id, userId: u.user.id, repositoryId: r.id, kind: "review-requested", title: t, href: "/x" } });

  // Link the GitHub-linked people through the real link code, then check what GitHub says they can open.
  await linkUser(alice.user.id, w.ws.id, "alice-gh");
  await linkUser(bob.user.id, w.ws.id, "bob-gh");
  await linkUser(dave.user.id, w.ws.id, "dave-gh");
  for (const u of [alice, bob, dave]) expect(await refresh(u.user.id)).toBe("ok");

  const as = async (userId: string, now?: Date) => (await loadViewer(db(), userId, w.ws.id, { now }))! as Viewer;
  return { w, admin, alice, bob, carol, dave, pub, priv1, priv2, pubPr, priv1Pr, priv2Pr, project, inst, owner, as };
}

// ---------- the rule ----------

describe("repoWhere: GitHub-verified access and explicit grants, additive", () => {
  it("a linked member sees exactly the repositories GitHub says they can open; an unlinked member only what was granted; administrators see everything", async () => {
    const x = await world();
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "pub"]); // alice-gh: collaborator on priv1, and everyone can read the public one
    expect(await names(await x.as(x.bob.user.id))).toEqual(["pub"]); // bob-gh can open no private repository
    expect(await names(await x.as(x.dave.user.id))).toEqual(["priv1", "pub"]); // a reader sees what GitHub shows them, too
    expect(await names(await x.as(x.carol.user.id))).toEqual(["pub"]); // no link: the explicit grant only
    expect(await names(x.w.viewer)).toEqual(["priv1", "priv2", "pub"]);
    expect(await names(await x.admin.viewer())).toEqual(["priv1", "priv2", "pub"]);
  });

  it("the two routes are additive: a grant adds to what GitHub shows, and a linked member keeps a grant GitHub knows nothing about", async () => {
    const x = await world();
    await db().repositoryGrant.create({ data: { memberId: x.alice.member.id, repositoryId: x.priv2.id, grantedById: x.w.owner.id, canManageWork: false, canReview: false } });
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "priv2", "pub"]);
    await db().repositoryGrant.updateMany({ where: { memberId: x.alice.member.id }, data: { revokedAt: new Date() } });
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "pub"]); // the GitHub route does not depend on the grant
    // and an unlinked member is unaffected by anybody's cached access
    expect(await visibleRepoIds(db(), await x.as(x.carol.user.id))).toEqual([x.pub.id]);
  });

  it("access GitHub no longer shows is gone after the next refresh, and the person's stored digest goes with it", async () => {
    const x = await world();
    await db().dailyDigest.create({ data: { workspaceId: x.w.ws.id, userId: x.alice.user.id, day: "2026-11-09", payload: { text: PRIV1 } as never } });
    expect(await names(await x.as(x.alice.user.id))).toContain("priv1");
    fake.revoke("acme", "priv1", "alice-gh");
    // until the next refresh nothing changes (the revocation lag is bounded by the validity window)
    expect(await names(await x.as(x.alice.user.id))).toContain("priv1");
    expect(await refresh(x.alice.user.id)).toBe("ok");
    expect(await names(await x.as(x.alice.user.id))).toEqual(["pub"]);
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id, repositoryGithubId: x.priv1.githubId } })).toBe(0);
    expect(await db().dailyDigest.count({ where: { userId: x.alice.user.id } })).toBe(0);
    // access GitHub grants later shows up at the next refresh too
    fake.repo("acme", "priv2")!.collaborators.set("alice-gh", "pull");
    await refresh(x.alice.user.id);
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv2", "pub"]);
  });

  it("stale rows fail closed: older than the validity window they grant nothing, until the refresh job has run again", async () => {
    const x = await world();
    const inWindow = new Date(Date.now() + VALID_FOR_MS - 60_000);
    const pastWindow = new Date(Date.now() + VALID_FOR_MS + 60_000);
    expect(await names(await x.as(x.alice.user.id, inWindow))).toEqual(["priv1", "pub"]);
    expect(await names(await x.as(x.alice.user.id, pastWindow))).toEqual([]);
    expect(await visibleRepoIds(db(), await x.as(x.alice.user.id, pastWindow))).toEqual([]);
    // granted repositories are unaffected by the age of the cache; the refresh renews access
    await db().repositoryGrant.create({ data: { memberId: x.alice.member.id, repositoryId: x.pub.id, grantedById: x.w.owner.id, canManageWork: false, canReview: false } });
    expect(await names(await x.as(x.alice.user.id, pastWindow))).toEqual(["pub"]);
    expect(await refresh(x.alice.user.id, pastWindow)).toBe("ok");
    expect(await names(await x.as(x.alice.user.id, pastWindow))).toEqual(["priv1", "pub"]);
  });

  it("a person linked to a DIFFERENT GitHub account does not see another person's repositories, and cannot read their rows", async () => {
    const x = await world();
    expect(await names(await x.as(x.bob.user.id))).toEqual(["pub"]);
    expect(await validRepoGithubIds(db(), x.bob.user.id, x.w.ws.id)).toEqual([x.pub.githubId]);
    // bob's id on GitHub is not alice's, and alice's rows are keyed by alice
    const aliceRows = await db().githubRepoAccess.findMany({ where: { userId: x.alice.user.id } });
    expect(aliceRows.length).toBeGreaterThan(0);
    expect(aliceRows.every((r) => r.userId === x.alice.user.id)).toBe(true);
    // a hand-built viewer for bob cannot borrow alice's list (the list is only ever read by user id)
    const forged = { ...(await x.as(x.bob.user.id)), githubRepoIds: [] as bigint[] };
    expect(await names(forged)).toEqual([]);
  });

  it("route two needs a repository tracked through an installation: a repository without one (local, demo) is never visible by GitHub's answer", async () => {
    const x = await world();
    await db().repository.update({ where: { id: x.priv1.id }, data: { installationId: null } });
    expect(await names(await x.as(x.alice.user.id))).toEqual(["pub"]);
    const v = await x.as(x.alice.user.id);
    expect(v.githubRepoIds).not.toContain(x.priv1.githubId); // the join already leaves it out
    // even a viewer that lists the id by hand cannot see it
    expect(await names({ ...v, githubRepoIds: [x.priv1.githubId, x.pub.githubId] })).toEqual(["pub"]);
  });

  it("a cached row only counts through the installation that serves the repository in THIS workspace", async () => {
    const x = await world();
    await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { installationId: 31337n } });
    expect(await names(await x.as(x.alice.user.id))).toEqual([]);
  });

  it("only read permissions count; an unknown permission or 'none' grants nothing", async () => {
    const x = await world();
    await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { permission: "none" } });
    expect(await names(await x.as(x.alice.user.id))).toEqual([]);
    await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { permission: "banana" } });
    expect(await names(await x.as(x.alice.user.id))).toEqual([]);
    for (const p of ["pull", "triage", "push", "maintain", "admin"]) {
      await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { permission: p } });
      expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "pub"]);
    }
  });

  it("untracked repositories stay hidden from everybody, and a viewer built by hand without the list has grants only", async () => {
    const x = await world();
    await db().repository.update({ where: { id: x.priv1.id }, data: { trackingStatus: "REMOVED" } });
    expect(await names(await x.as(x.alice.user.id))).toEqual(["pub"]);
    const bare = { ...(await x.as(x.alice.user.id)) } as Viewer;
    delete bare.githubRepoIds;
    expect(await names(bare)).toEqual([]);
    expect(repoWhere({ ...bare, isAdmin: true })).toEqual({ workspaceId: x.w.ws.id, trackingStatus: { not: "REMOVED" } }); // administrators: unchanged
  });

  it("two workspaces sharing one installation each expose only what THEY track; membership in one grants nothing in the other", async () => {
    const x = await world();
    const w2 = await workspaceWithOwner(db(), "owner2@other.test", "Other");
    // Isolation of access rows, not joining: organization members would otherwise join both workspaces (tests/github-org-join.test.ts).
    await db().workspace.updateMany({ data: { githubOrgAutoJoin: false } });
    await bind(db(), w2.ws.id, x.inst).catch(() => {}); // already bound once: bind() re-creates the installation row, only the binding is needed
    await db().workspaceInstallation.upsert({ where: { workspaceId_installationId: { workspaceId: w2.ws.id, installationId: BigInt(x.inst.id) } }, create: { workspaceId: w2.ws.id, installationId: BigInt(x.inst.id), verifiedAt: new Date(), verifiedGithubUserId: 78n, proofMethod: "user-installations" }, update: {} });
    const o2 = await db().githubOwner.findFirstOrThrow({ where: { githubId: 500n } });
    // The second workspace tracks ONLY the public repository.
    await db().repository.create({ data: { workspaceId: w2.ws.id, githubId: x.pub.githubId, ownerId: o2.id, name: "pub", fullName: "acme/pub", htmlUrl: "https://github.com/acme/pub", visibility: "PUBLIC", defaultBranch: "main", installationId: BigInt(x.inst.id) } });
    // alice belongs to both workspaces, eve only to the second (and is an org member on GitHub too).
    await db().member.create({ data: { workspaceId: w2.ws.id, userId: x.alice.user.id, role: "MEMBER", status: "ACTIVE" } });
    const eve = await addMember(db(), w2.ws.id, "eve@other.test", "MEMBER");
    await linkUser(eve.user.id, w2.ws.id, "eve-gh");
    expect(await refresh(x.alice.user.id)).toBe("ok");
    expect(await refresh(eve.user.id)).toBe("ok");

    const aliceHere = await loadViewer(db(), x.alice.user.id, x.w.ws.id);
    const aliceThere = await loadViewer(db(), x.alice.user.id, w2.ws.id);
    expect(await names(aliceHere!)).toEqual(["priv1", "pub"]);
    expect(await names(aliceThere!)).toEqual(["pub"]); // priv1 is not tracked in the other workspace: not exposed there
    const eveThere = (await loadViewer(db(), eve.user.id, w2.ws.id))!;
    expect(await names(eveThere)).toEqual(["pub"]);
    // eve is not a member of the first workspace at all
    expect(await loadViewer(db(), eve.user.id, x.w.ws.id)).toBeNull();
    // the second workspace's repository rows never leak into the first
    expect((await db().repository.findMany({ where: repoWhere(aliceHere!) })).every((r) => r.workspaceId === x.w.ws.id)).toBe(true);
  });
});

// ---------- every consumer ----------

describe("every consumer honours route two, for a linked member and for a reader", () => {
  for (const who of ["alice", "dave"] as const) {
    it(`lists, search, counts, queues, inbox, digest, AI, notifications, activity and planning (${who}): GitHub's repositories appear, the hidden one never does`, async () => {
      const x = await world();
      const v = await x.as(x[who].user.id);
      const seen: Record<string, unknown> = {};
      seen.workItems = await listWorkItems(db(), v, { state: "ALL" });
      seen.search = await Promise.all([searchGlobal(db(), v, "SECRET"), searchGlobal(db(), v, "priv2"), searchGlobal(db(), v, "PRIV2-COMMENT")]);
      seen.repos = await listRepositories(db(), v);
      seen.overview = await overview(db(), v, NOW);
      seen.queues = await attention(db(), v, { now: NOW });
      seen.inbox = await inbox(db(), v, { now: NOW });
      seen.notifications = [await listNotifications(db(), v), await unreadNotificationCount(db(), v)];
      seen.projects = await listProjects(db(), v);
      seen.ai = (await buildSnapshot(db(), v, NOW)).text;
      seen.digest = await buildDigest(db(), v, { now: NOW, day: "2026-11-09" });
      seen.federationBoard = await boardDto(db(), v, x.project.id);
      seen.federationTasks = await tasksDto(db(), v, x.project.id, { limit: 50, cursor: null });
      seen.federationProjects = await listProjectsDto(db(), v, { limit: 50, cursor: null });
      for (const [k, val] of Object.entries(seen)) expect(leaks(val, hidden), `${k} must not leak the hidden repository`).toEqual([]);
      // what GitHub shows them is there
      expect((await listWorkItems(db(), v, { state: "ALL" })).rows.map((r) => r.title).sort()).toEqual([PRIV1, PUB].sort());
      expect((await searchGlobal(db(), v, "SECRET")).workItems.map((i) => i.title)).toEqual([PRIV1]);
      expect((await listRepositories(db(), v)).map((r) => r.fullName).sort()).toEqual(["acme/priv1", "acme/pub"]);
      expect((seen.overview as { openPrs: number }).openPrs).toBe(2);
      expect((seen.projects as { repoCount: number }[])[0].repoCount).toBe(2);
      expect((await listNotifications(db(), v)).map((nn) => nn.title).sort()).toEqual(who === "alice" ? [`Review requested: ${PRIV1}`, `Review requested: ${PUB}`].sort() : []);
      const board = (seen.federationBoard as Awaited<ReturnType<typeof boardDto>>).columns.flatMap((c) => c.items.map((i) => i.title));
      expect([...board].sort()).toEqual([PRIV1, PUB].sort());
    });

    it(`direct ids: the visible repository's item opens, the hidden one is not found (${who})`, async () => {
      const x = await world();
      const v = await x.as(x[who].user.id);
      expect((await getWorkItemDetail(db(), v, x.priv1Pr.id)).title).toBe(PRIV1);
      expect((await requireRepo(db(), v, x.priv1.id)).id).toBe(x.priv1.id);
      await expect(requireRepo(db(), v, x.priv2.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(requireWorkItem(db(), v, x.priv2Pr.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getWorkItemDetail(db(), v, x.priv2Pr.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(derivedDetail(db(), v, x.priv2Pr.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  }

  it("visibility through GitHub is read only: no grant, no changes (a clear refusal, not a pretence of not finding it)", async () => {
    const x = await world();
    const v = await x.as(x.alice.user.id);
    await expect(requireRepo(db(), v, x.priv1.id, "manageWork")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await capabilitiesFor(db(), v, x.priv1.id)).toEqual({ view: true, manageWork: false, review: false });
    expect(await capabilitiesFor(db(), v, x.priv2.id)).toEqual({ view: false, manageWork: false, review: false });
    // the reader is read-only whatever GitHub says
    const d = await x.as(x.dave.user.id);
    expect(await capabilitiesFor(db(), d, x.priv1.id)).toEqual({ view: true, manageWork: false, review: false });
  });

  it("the JSON routes: 200 for a pull request GitHub shows the person, 404 for one it does not, 404 for an unlinked member", async () => {
    const x = await world();
    const { GET } = await import("@/app/api/pr/[id]/threads/route");
    const call = async (userId: string, id: string) => {
      const { token } = await createSession(db(), userId, new Date(), x.w.ws.id);
      state.jar.set(SESSION_COOKIE, { value: token, options: {} });
      return GET(new Request(`${ORIGIN}/api/pr/${id}/threads`, { headers: { host: HOST } }), { params: Promise.resolve({ id }) });
    };
    expect((await call(x.alice.user.id, x.priv1Pr.id)).status).toBe(200);
    expect((await call(x.alice.user.id, x.priv2Pr.id)).status).toBe(404);
    expect((await call(x.bob.user.id, x.priv1Pr.id)).status).toBe(404);
    expect((await call(x.carol.user.id, x.priv1Pr.id)).status).toBe(404);
  });

  it("an unlinked member and a member whose GitHub account has no access see none of the private repositories in any consumer", async () => {
    const x = await world();
    for (const who of ["carol", "bob"] as const) {
      const v = await x.as(x[who].user.id);
      const everything = [await listWorkItems(db(), v, { state: "ALL" }), await searchGlobal(db(), v, "SECRET"), await listRepositories(db(), v), await attention(db(), v, { now: NOW }), await inbox(db(), v, { now: NOW }), (await buildSnapshot(db(), v, NOW)).text, await boardDto(db(), v, x.project.id)];
      expect(leaks(everything, ["PRIV1", "PRIV2", "priv1", "priv2"]), who).toEqual([]);
    }
  });

  it("nobody spreads repoWhere and then sets AND (that would replace the GitHub route); callers that add their own OR stay safe", () => {
    const root = path.resolve(import.meta.dirname, "..", "src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "generated") walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            const at = line.indexOf("...repoWhere(");
            if (at >= 0 && /\bAND\s*:/.test(line.slice(at))) bad.push(`${path.relative(root, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });

  it("a caller that spreads repoWhere and adds its own OR (the stale-repositories count) cannot widen what a member sees", async () => {
    const x = await world();
    const v = await x.as(x.bob.user.id);
    await db().repository.update({ where: { id: x.priv2.id }, data: { syncError: "boom" } });
    const stale = await db().repository.count({ where: { ...repoWhere(v), OR: [{ rateLimited: true }, { trackingStatus: "DISCONNECTED" }, { syncError: { not: null } }] } });
    expect(stale).toBe(0); // priv2 has an error but bob cannot see it
    const admin = await db().repository.count({ where: { ...repoWhere(x.w.viewer), OR: [{ syncError: { not: null } }] } });
    expect(admin).toBe(1);
  });
});

// ---------- purging ----------

describe("removing a member and unlinking purge the cached access", () => {
  it("removing a member deletes the cached access that came through the workspace's installations and the stored digest", async () => {
    const x = await world();
    await db().dailyDigest.create({ data: { workspaceId: x.w.ws.id, userId: x.alice.user.id, day: "2026-11-09", payload: {} as never } });
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBeGreaterThan(0);
    await removeMember(db(), x.w.viewer, x.alice.member.id);
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(0);
    expect(await db().dailyDigest.count({ where: { userId: x.alice.user.id } })).toBe(0);
    expect(await loadViewer(db(), x.alice.user.id, x.w.ws.id)).toBeNull();
    // other people's rows are untouched
    expect(await db().githubRepoAccess.count({ where: { userId: x.dave.user.id } })).toBeGreaterThan(0);
  });

  it("access that came through an installation another workspace the person still belongs to uses is kept", async () => {
    const x = await world();
    const w2 = await workspaceWithOwner(db(), "owner2@other.test", "Other");
    await db().workspaceInstallation.create({ data: { workspaceId: w2.ws.id, installationId: BigInt(x.inst.id), verifiedAt: new Date(), verifiedGithubUserId: 78n, proofMethod: "user-installations" } });
    await db().member.create({ data: { workspaceId: w2.ws.id, userId: x.alice.user.id, role: "MEMBER", status: "ACTIVE" } });
    await removeMember(db(), x.w.viewer, x.alice.member.id);
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBeGreaterThan(0);
  });

  it("unlinking removes every row and the person sees only what was granted", async () => {
    const x = await world();
    await db().repositoryGrant.create({ data: { memberId: x.alice.member.id, repositoryId: x.pub.id, grantedById: x.w.owner.id, canManageWork: false, canReview: false } });
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "pub"]);
    await unlinkGithubAccount(db(), { userId: x.alice.user.id, workspaceId: x.w.ws.id }, cfg());
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(0);
    const v = await x.as(x.alice.user.id);
    expect(v.githubLogin).toBeNull();
    expect(await names(v)).toEqual(["pub"]); // the grant survives, nothing else
    expect(await db().githubRepoAccess.count({ where: { userId: x.dave.user.id } })).toBeGreaterThan(0);
  });
});

// ---------- the refresh job ----------

describe("the refresh job", () => {
  it("is isolated to one person: only their rows change and only their own token is used", async () => {
    const x = await world();
    const bobRowsBefore = JSON.stringify(await db().githubRepoAccess.findMany({ where: { userId: x.bob.user.id }, orderBy: { repositoryGithubId: "asc" } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    seenAuth.length = 0;
    expect(await refresh(x.alice.user.id)).toBe("ok");
    const aliceRow = (await db().githubUserToken.findUnique({ where: { userId: x.alice.user.id } }))!;
    const aliceToken = decryptSecret(aliceRow.accessEnc!, key(), tokenAad(x.alice.user.id))!;
    const bearer = new Set(seenAuth.map((s) => s.split("|")[0]));
    expect([...bearer]).toEqual([`Bearer ${aliceToken}`]);
    expect(JSON.stringify(await db().githubRepoAccess.findMany({ where: { userId: x.bob.user.id }, orderBy: { repositoryGithubId: "asc" } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(bobRowsBefore);
    // and it reads nothing of an installation no workspace of theirs is bound to
    fake.addUser("lonely");
    const other = fake.addInstallation("lonely", { selection: "all" });
    seenAuth.length = 0;
    await refresh(x.alice.user.id);
    expect(seenAuth.some((s) => s.includes(`/user/installations/${other.id}/`))).toBe(false);
  });

  it("only the installations bound to a workspace the person belongs to are listed, with their own token, page by page", async () => {
    const x = await world();
    seenAuth.length = 0;
    await refresh(x.alice.user.id);
    const paths = seenAuth.map((s) => s.split("|")[1]);
    expect(paths).toContain("/user");
    expect(paths).toContain("/user/installations");
    expect(paths.filter((p) => p === `/user/installations/${x.inst.id}/repositories`).length).toBeGreaterThanOrEqual(1);
    expect(paths.every((p) => p === "/user" || p.startsWith("/user/installations") || p === "/login/oauth/access_token")).toBe(true);
  });

  it("records when the person's access was last checked, and asks again only when that is older than REFRESH_AFTER", async () => {
    const x = await world();
    const row = (await db().githubUserToken.findUnique({ where: { userId: x.alice.user.id } }))!;
    expect(row.accessCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await maybeRequestAccessRefresh(db(), x.alice.user.id)).toBe(false); // fresh: nothing to do
    const later = new Date(Date.now() + REFRESH_AFTER_MS + 1000);
    expect(await maybeRequestAccessRefresh(db(), x.alice.user.id, later)).toBe(true);
    expect(await db().job.count({ where: { type: ACCESS_JOB, dedupeKey: `ghaccess:${x.alice.user.id}` } })).toBe(1);
    // a second page load right after does not queue it again (and a failing job cannot be re-queued in a loop)
    expect(await maybeRequestAccessRefresh(db(), x.alice.user.id, new Date(later.getTime() + 1000))).toBe(false);
    // a person with no link, or one that needs relinking, never queues anything
    expect(await maybeRequestAccessRefresh(db(), x.carol.user.id, later)).toBe(false);
    await db().githubUserToken.update({ where: { userId: x.bob.user.id }, data: { status: "RELINK" } });
    expect(await maybeRequestAccessRefresh(db(), x.bob.user.id, later)).toBe(false);
  });

  it("runs as the queued job, and the scheduler's reconcile queues one for every linked person whose data is old", async () => {
    const x = await world();
    const { handlers } = await import("@/lib/worker/handlers");
    await db().githubRepoAccess.deleteMany({ where: { userId: x.alice.user.id } });
    await handlers[ACCESS_JOB]({ userId: x.alice.user.id } as never, {} as never);
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBeGreaterThan(0);
    // reconcile: bob's data is old, alice's is fresh
    await db().githubUserToken.update({ where: { userId: x.bob.user.id }, data: { accessCheckedAt: new Date(Date.now() - 3 * REFRESH_AFTER_MS) } });
    await db().job.deleteMany({});
    await handlers["reconcile.all"]({} as never, {} as never);
    const queued = (await db().job.findMany({ where: { type: ACCESS_JOB } })).map((j) => (j.payload as { userId: string }).userId);
    expect(queued).toContain(x.bob.user.id);
    expect(queued).not.toContain(x.alice.user.id);
    expect(queued).not.toContain(x.carol.user.id); // no link
    await db().job.deleteMany({ where: { type: { not: ACCESS_JOB } } });
    expect(await runOne(db(), { [ACCESS_JOB]: handlers[ACCESS_JOB] }, new Date(Date.now() + 1000))).toMatch(/done|requeued/);
  });

  it("has a generous per-person budget (key user:<id>): past it the job asks GitHub for nothing, and another person's budget is their own", async () => {
    const x = await world();
    await db().rateLimitState.deleteMany({});
    for (let i = 0; i < USER_BUDGET_MAX; i++) expect(["ok", "partial"]).toContain(await refresh(x.alice.user.id));
    expect(await db().rateLimitState.findUnique({ where: { key: userBudgetKey(x.alice.user.id) } })).toMatchObject({ remaining: 0, limit: USER_BUDGET_MAX });
    const calls = fake.calls.length;
    expect(await refresh(x.alice.user.id)).toBe("rate-limited");
    expect(fake.calls.length).toBe(calls);
    expect(await refresh(x.dave.user.id)).toBe("ok");
    expect(userBudgetKey("abc")).toBe("user:abc");
  });

  it("a listing that fails leaves that installation's rows to age out (still valid until then), reports partial and keeps the check time old", async () => {
    const x = await world();
    const before = (await db().githubUserToken.findUnique({ where: { userId: x.alice.user.id } }))!.accessCheckedAt!;
    await new Promise((r) => setTimeout(r, 15));
    fake.failNext(new RegExp(`/user/installations/${x.inst.id}/repositories`), 502, "bad gateway", 5);
    expect(await refresh(x.alice.user.id)).toBe("partial");
    expect((await db().githubUserToken.findUnique({ where: { userId: x.alice.user.id } }))!.accessCheckedAt!.getTime()).toBe(before.getTime());
    const rows = await db().githubRepoAccess.findMany({ where: { userId: x.alice.user.id } });
    expect(rows.length).toBe(2); // untouched
    expect(rows.every((r) => r.checkedAt.getTime() <= Date.now())).toBe(true);
    // rows that were not renewed stop counting after the window
    expect(await names(await x.as(x.alice.user.id, new Date(Date.now() + VALID_FOR_MS + 60_000)))).toEqual([]);
  });

  it("token revoked at GitHub: one renewal attempt, then the link needs renewing and the person's cached access is gone", async () => {
    const x = await world();
    fake.revokeAllUserTokens("alice-gh");
    expect(await refresh(x.alice.user.id)).toBe("relink");
    expect((await db().githubUserToken.findUnique({ where: { userId: x.alice.user.id } }))!.status).toBe("RELINK");
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(0);
    expect(await names(await x.as(x.alice.user.id))).toEqual([]); // fail closed
    const calls = fake.calls.length;
    expect(await refresh(x.alice.user.id)).toBe("relink");
    expect(fake.calls.length).toBe(calls); // stops: no loop
  });

  it("a token that belongs to a different GitHub account than the one linked is never used", async () => {
    const x = await world();
    await db().user.update({ where: { id: x.alice.user.id }, data: { githubId: 999_999n } }); // linked id and the token's account disagree
    expect(await refresh(x.alice.user.id)).toBe("relink");
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(0);
  });

  it("a renamed GitHub login is picked up whenever the token is used, and the viewer shows it", async () => {
    const x = await world();
    expect((await x.as(x.alice.user.id)).githubLogin).toBe("alice-gh");
    fake.users.get("alice-gh")!.login = "alice-renamed";
    await refresh(x.alice.user.id);
    expect((await x.as(x.alice.user.id)).githubLogin).toBe("alice-renamed");
  });

  it("an unlink that lands while a refresh is running wins: the refresh writes nothing afterwards", async () => {
    const x = await world();
    // Start the unlink from inside the refresh: the first GitHub call that reaches the fake triggers it.
    let fired = false;
    const base = fake.appFetch();
    setConnectOverridesForTests({
      deps: {
        fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
          if (!fired && String(i).endsWith("/user/installations?per_page=100&page=1")) {
            fired = true;
            await unlinkGithubAccount(db(), { userId: x.alice.user.id, workspaceId: x.w.ws.id }, null);
          }
          return base(i, init);
        }) as typeof fetch,
      },
    });
    expect(await refresh(x.alice.user.id)).toBe("aborted");
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(0);
    expect(await db().githubUserToken.count({ where: { userId: x.alice.user.id } })).toBe(0);
  });

  it("a person with no link, or a person that is not a member of any workspace with an installation, costs GitHub nothing", async () => {
    const x = await world();
    expect(await refresh(x.carol.user.id)).toBe("none");
    expect(MAX_VIEWER_REPO_IDS).toBeGreaterThanOrEqual(1000);
    const calls = fake.calls.length;
    await db().member.updateMany({ where: { userId: x.dave.user.id }, data: { status: "REVOKED" } });
    expect(await refresh(x.dave.user.id)).toBe("ok");
    expect(fake.calls.slice(calls).some((c) => c.includes("/repositories"))).toBe(false); // no active membership: nothing is listed
    expect(await db().githubRepoAccess.count({ where: { userId: x.dave.user.id } })).toBe(0);
  });
});

// ---------- review fixes ----------

const signInAs = async (userId: string, workspaceId: string) => {
  const { token } = await createSession(db(), userId, new Date(), workspaceId);
  state.jar.set(SESSION_COOKIE, { value: token, options: {} });
};
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("F1: seeing a repository through GitHub never allows a change", () => {
  it("a GitHub-only member is Forbidden to refresh a repository and to refresh a fork; a granted member and an administrator are not", async () => {
    const x = await world();
    await db().forkMapping.create({ data: { forkRepoId: x.priv1.id, upstreamRepoId: x.pub.id, forkBranch: "main", upstreamBranch: "main" } });
    const mapping = await db().forkMapping.findFirstOrThrow({});
    const noGrant = /no grant to change it/;

    await signInAs(x.alice.user.id, x.w.ws.id); // sees priv1 and pub through GitHub only
    const r1 = await refreshRepositoryAction(form({ repositoryId: x.priv1.id }));
    expect(!r1.ok && r1.error).toMatch(noGrant);
    const r2 = await refreshForkAction(form({ mappingId: mapping.id }));
    expect(!r2.ok && r2.error).toMatch(noGrant);
    expect(await db().job.count({ where: { type: { in: ["sync.repository", "sync.fork"] } } })).toBe(0);

    // a member with a real grant (canManageWork) still works
    await db().repositoryGrant.create({ data: { memberId: x.carol.member.id, repositoryId: x.priv1.id, grantedById: x.w.owner.id, canManageWork: true, canReview: true } });
    await signInAs(x.carol.user.id, x.w.ws.id);
    expect((await refreshRepositoryAction(form({ repositoryId: x.priv1.id }))).ok).toBe(true);
    expect((await refreshForkAction(form({ mappingId: mapping.id }))).ok).toBe(true);

    // an administrator works
    await signInAs(x.w.owner.id, x.w.ws.id);
    expect((await refreshRepositoryAction(form({ repositoryId: x.priv2.id }))).ok).toBe(true);
    expect((await refreshForkAction(form({ mappingId: mapping.id }))).ok).toBe(true);
  });

  it("'read' is the only read capability and the default; every change names manageWork or review", async () => {
    const x = await world();
    const v = await x.as(x.alice.user.id);
    expect((await requireRepo(db(), v, x.priv1.id)).id).toBe(x.priv1.id);
    expect((await requireRepo(db(), v, x.priv1.id, "read")).id).toBe(x.priv1.id);
    await expect(requireRepo(db(), v, x.priv1.id, "manageWork")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireRepo(db(), v, x.priv1.id, "review")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("F2: a stored digest is never served after the access it was made from is gone", () => {
  const DAY = "2026-11-09";
  it("an expired window, a failed refresh, a relink and a digest from before this rule are all not served", async () => {
    const x = await world();
    const v = await x.as(x.alice.user.id);
    const made = await generateDigest(db(), v, { now: NOW, day: DAY });
    expect(JSON.stringify(made.digest.payload)).toContain(PRIV1);
    expect((await getDigest(db(), v, DAY))?.id).toBe(made.digest.id);
    expect((await latestDigest(db(), v))?.id).toBe(made.digest.id);

    // the window runs out (a refresh that keeps failing): the stored digest is dropped from view whether or not any purge ran
    const pastWindow = new Date(Date.now() + VALID_FOR_MS + 60_000);
    const later = await x.as(x.alice.user.id, pastWindow);
    expect(await getDigest(db(), later, DAY)).toBeNull();
    expect(await latestDigest(db(), later)).toBeNull();
    fake.offline = true;
    await expect(refresh(x.alice.user.id, pastWindow)).rejects.toBeInstanceOf(GithubAppError);
    fake.offline = false;
    expect(await getDigest(db(), later, DAY)).toBeNull();

    // relink purges the row itself, and nothing is served
    await generateDigest(db(), v, { now: NOW, day: DAY, replace: true });
    expect(await getDigest(db(), v, DAY)).not.toBeNull();
    await markRelink(db(), x.alice.user.id);
    expect(await db().dailyDigest.count({ where: { userId: x.alice.user.id } })).toBe(0);
    expect(await getDigest(db(), await x.as(x.alice.user.id), DAY)).toBeNull();

    // a digest stored without a visibility key (made before this rule) is never served
    await db().dailyDigest.create({ data: { workspaceId: x.w.ws.id, userId: x.carol.user.id, day: DAY, payload: { version: 1, secret: PRIV1 } as never } });
    expect(await getDigest(db(), await x.as(x.carol.user.id), DAY)).toBeNull();
    expect(await latestDigest(db(), await x.as(x.carol.user.id))).toBeNull();
  });

  it("when a refresh finds that GitHub no longer shows a repository, the person's digest is gone and the next one is built from what they see now", async () => {
    const x = await world();
    await generateDigest(db(), await x.as(x.alice.user.id), { now: NOW, day: DAY });
    fake.revoke("acme", "priv1", "alice-gh");
    await refresh(x.alice.user.id);
    expect(await db().dailyDigest.count({ where: { userId: x.alice.user.id } })).toBe(0);
    const again = await generateDigest(db(), await x.as(x.alice.user.id), { now: NOW, day: DAY });
    expect(JSON.stringify(again.digest.payload)).not.toContain(PRIV1);
  });

  it("a stored digest also drops when what the person may see changes the other way (a grant arrives): it is rebuilt, never shown stale", async () => {
    const x = await world();
    await generateDigest(db(), await x.as(x.bob.user.id), { now: NOW, day: DAY });
    await db().repositoryGrant.create({ data: { memberId: x.bob.member.id, repositoryId: x.priv2.id, grantedById: x.w.owner.id, canManageWork: false, canReview: false } });
    expect(await getDigest(db(), await x.as(x.bob.user.id), DAY)).toBeNull();
    await generateDigest(db(), await x.as(x.bob.user.id), { now: NOW, day: DAY });
    expect(await getDigest(db(), await x.as(x.bob.user.id), DAY)).not.toBeNull();
    expect(await db().dailyDigest.count({ where: { userId: x.bob.user.id } })).toBe(1); // replaced in place
  });
});

describe("F3: only a dead token ends a link; rate limiting and outages never do", () => {
  const link = (userId: string) => db().githubUserToken.findUniqueOrThrow({ where: { userId } });
  it("a rate-limit 403 (primary or secondary), a 429, an unexplained 403 and a 5xx throw and keep the token, the cached rows and the stored login; the job backs off", async () => {
    const x = await world();
    const before = await link(x.alice.user.id);
    const rows = await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } });
    fake.rateLimitedUntil = Date.now() + 3600_000;
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    fake.rateLimitedUntil = null;
    fake.failNext(/^GET \/user$/, 403, "You have exceeded a secondary rate limit. Please wait a few minutes.");
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    fake.failNext(/^GET \/user$/, 429, "Too Many Requests");
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    fake.failNext(/^GET \/user$/, 403, "Forbidden");
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    fake.failNext(/^GET \/user\/installations\?/, 403, "API rate limit exceeded for user");
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    fake.failNext(/^GET \/user$/, 503, "unavailable");
    await expect(refresh(x.alice.user.id)).rejects.toBeInstanceOf(GithubAppError);
    const after = await link(x.alice.user.id);
    expect(after.status).toBe("OK");
    expect(after.accessEnc).toBe(before.accessEnc);
    expect(after.accessCheckedAt!.getTime()).toBe(before.accessCheckedAt!.getTime());
    expect(await db().githubRepoAccess.count({ where: { userId: x.alice.user.id } })).toBe(rows);
    expect((await db().user.findUniqueOrThrow({ where: { id: x.alice.user.id } })).githubLogin).toBe("alice-gh");
    // as a queued job the failure is a retry, not an end
    fake.rateLimitedUntil = Date.now() + 3600_000;
    await db().job.deleteMany({});
    await requestAccessRefresh(db(), x.alice.user.id);
    const { handlers } = await import("@/lib/worker/handlers");
    expect(await runOne(db(), { [ACCESS_JOB]: handlers[ACCESS_JOB] }, new Date(Date.now() + 1000))).toBe("retry");
    fake.rateLimitedUntil = null;
    expect((await link(x.alice.user.id)).status).toBe("OK");
  });

  it("a revoked token (401, or a 403 that says bad credentials) is dead: the link needs renewing", async () => {
    const x = await world();
    fake.failNext(/^GET \/user$/, 403, "Bad credentials", 2); // the first read and the one after the forced renewal
    expect(await refresh(x.bob.user.id)).toBe("relink");
    expect((await link(x.bob.user.id)).status).toBe("RELINK");
    fake.revokeAllUserTokens("dave-gh");
    expect(await refresh(x.dave.user.id)).toBe("relink");
  });
});

describe("F5: a stored GitHub login is only trusted while the link is fresh", () => {
  it("is cleared when the link needs renewing and on unlink, and ignored when the last check with GitHub is older than 24 hours", async () => {
    const x = await world();
    expect((await x.as(x.alice.user.id)).githubLogin).toBe("alice-gh");
    const stale = new Date(Date.now() + 25 * 3600_000);
    expect((await x.as(x.alice.user.id, stale)).githubLogin).toBeNull(); // not confirmed for a day: matches nobody's queue
    await refresh(x.alice.user.id, stale);
    expect((await x.as(x.alice.user.id, stale)).githubLogin).toBe("alice-gh");
    await markRelink(db(), x.alice.user.id);
    expect((await db().user.findUniqueOrThrow({ where: { id: x.alice.user.id } })).githubLogin).toBeNull();
    expect((await x.as(x.alice.user.id)).githubLogin).toBeNull();
    await unlinkGithubAccount(db(), { userId: x.dave.user.id, workspaceId: x.w.ws.id }, cfg());
    expect((await x.as(x.dave.user.id)).githubLogin).toBeNull();
  });
});

describe("F6: a listing that cannot be complete is marked truncated; the viewer's list has a stable order", () => {
  it("more repositories than the page cap allows: marked truncated with a count, and the tracked repositories are still found", async () => {
    const x = await world();
    for (let i = 0; i < 5001; i++) {
      fake.repos.set(`acme/bulk${i}`, { id: 100_000 + i, owner: "acme", name: `bulk${i}`, private: false, defaultBranch: "main", collaborators: new Map(), invitations: new Map(), objects: new Map(), refs: new Map() });
    }
    expect(await refresh(x.alice.user.id)).toBe("ok");
    const row = await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } });
    expect(row.accessTruncated).toBe(true);
    expect(row.accessRepoCount).toBeGreaterThanOrEqual(5000);
    expect(await names(await x.as(x.alice.user.id))).toEqual(["priv1", "pub"]);
    for (let i = 0; i < 5001; i++) fake.repos.delete(`acme/bulk${i}`);
    await refresh(x.alice.user.id);
    expect((await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } })).accessTruncated).toBe(false);
  }, 120_000);

  it("the cutoff is exact at the boundary (compared as UTC text, so a server time zone cannot shift it)", async () => {
    const x = await world();
    const edge = Date.now() - VALID_FOR_MS;
    await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { checkedAt: new Date(edge + 5_000) } });
    expect((await validRepoGithubIds(db(), x.alice.user.id, x.w.ws.id)).length).toBe(2);
    await db().githubRepoAccess.updateMany({ where: { userId: x.alice.user.id }, data: { checkedAt: new Date(edge - 5_000) } });
    expect(await validRepoGithubIds(db(), x.alice.user.id, x.w.ws.id)).toEqual([]);
  });
});

describe("F7: a refresh that started before an unlink and a new link cannot wipe the new link", () => {
  it("markRelinkIfCurrent leaves a link that is not the version the caller used", async () => {
    const x = await world();
    const old = (await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } })).updatedAt;
    await unlinkGithubAccount(db(), { userId: x.alice.user.id, workspaceId: x.w.ws.id }, null);
    await linkUser(x.alice.user.id, x.w.ws.id, "alice-gh");
    expect(await markRelinkIfCurrent(db(), x.alice.user.id, old)).toBe(false);
    const current = (await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } })).updatedAt;
    expect((await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } })).status).toBe("OK");
    expect(await markRelinkIfCurrent(db(), x.alice.user.id, current)).toBe(true);
  });

  it("end to end: the old token is refused mid-refresh while the person unlinks and links again; the new link survives", async () => {
    const x = await world();
    let fired = false;
    const base = fake.appFetch();
    fake.revokeAllUserTokens("alice-gh"); // the token this refresh will use is dead at GitHub
    setConnectOverridesForTests({
      deps: {
        fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
          if (!fired && new URL(String(i)).pathname === "/user") {
            fired = true;
            await unlinkGithubAccount(db(), { userId: x.alice.user.id, workspaceId: x.w.ws.id }, null);
            await linkUser(x.alice.user.id, x.w.ws.id, "alice-gh"); // a brand new link with a working token
          }
          return base(i, init);
        }) as typeof fetch,
      },
    });
    await refresh(x.alice.user.id);
    const row = await db().githubUserToken.findUniqueOrThrow({ where: { userId: x.alice.user.id } });
    expect(row.status).toBe("OK");
    expect(row.accessEnc).not.toBeNull();
  });
});

describe("the public-repository rule is as documented", () => {
  it("a linked member sees an administrator-tracked public repository that GitHub lists for them; an unlinked member without a grant does not", async () => {
    const x = await world();
    const frank = await addMember(db(), x.w.ws.id, "frank@acme.test", "MEMBER");
    expect(await names(await x.as(x.bob.user.id))).toEqual(["pub"]);
    expect(await names((await frank.viewer()) as Viewer)).toEqual([]);
  });
});
