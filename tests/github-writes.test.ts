import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { state } from "./auth-mocks";
import { hostedGithub, releaseApp, useApp as stubApp, bind } from "./github-hosted-helpers";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { take } from "@/lib/auth/rate-limit";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { setConnectOverridesForTests } from "@/lib/github/connect";
import type { FakeGitHubServer } from "@/lib/github/fake-server";
import { unbindInstallation } from "@/lib/github/binding";
import { markRelink, storeUserTokens, userTokenKey } from "@/lib/github/user-token";
import { GithubWriteError, GithubWriteRefusedError, REFUSAL_MESSAGES, workspaceWriteKey, userWriteKey, withFooter, writeRefusal } from "@/lib/github/writes";
import { githubWritesCeiling, githubWritesSettingProblem } from "@/lib/github/writes-ceiling";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { createColumnsForProject } from "@/lib/services/planning";
import { createTask } from "@/lib/services/tasks";
import { githubWritesView, setWorkspaceGithubWrites } from "@/lib/services/github-writes-setting";
import { issueDestinationsByProject, linkPendingTasks, previewPromotion, promoteTask } from "@/lib/services/task-promotion";
import { addComment } from "@/lib/services/work-actions";

/**
 * Opt-in GitHub writes made as the person (docs/github-app.md, "Writing to GitHub as you"), against the in-memory GitHub. The fake
 * enforces that a write carries the person's own user token (an installation token is refused) and records every write.
 */
const ENC_KEY = "k".repeat(40);
let n = 0;
let server: FakeGitHubServer;
const db = () => state.db!;

beforeEach(() => {
  state.db = createTestPrisma(`github-writes-${n++}`);
  vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", ENC_KEY);
  vi.stubEnv("MERGEPORT_GITHUB_WRITES", "on");
  vi.stubEnv("DEMO_MODE", "false");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  releaseApp();
  setConnectOverridesForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.db!.$disconnect();
});

type World = Awaited<ReturnType<typeof world>>;

async function world() {
  const h = hostedGithub();
  server = h.server;
  stubApp(server, h.app);
  setConnectOverridesForTests({ deps: { fetch: server.appFetch() } });
  const repoJson = (await (await h.create("web", true)).json()) as { id: number };
  const inst = server.addInstallation("acme", { repos: ["acme/web"] });
  const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
  await db().workspace.update({ where: { id: w.ws.id }, data: { githubWritesEnabled: true } });
  await bind(db(), w.ws.id, inst);
  const owner = await db().githubOwner.create({ data: { githubId: BigInt(server.orgs.get("acme")!.id), login: "acme", type: "ORGANIZATION" } });
  const repo = await db().repository.create({
    data: { workspaceId: w.ws.id, githubId: BigInt(repoJson.id), ownerId: owner.id, name: "web", fullName: "acme/web", htmlUrl: "https://github.com/acme/web", visibility: "PRIVATE", defaultBranch: "main", installationId: BigInt(inst.id), lastSyncedAt: new Date() },
  });
  const project = await db().project.create({ data: { workspaceId: w.ws.id, name: "Platform", slug: "platform" } });
  await createColumnsForProject(db(), project.id);
  await db().projectRepository.create({ data: { projectId: project.id, repositoryId: repo.id } });
  const adminMember = await db().member.findFirstOrThrow({ where: { workspaceId: w.ws.id, userId: w.owner.id } });
  await db().projectMember.create({ data: { projectId: project.id, memberId: adminMember.id } });

  /** A member with a grant, a project seat, and (optionally) a linked GitHub account with a working token and a cached grant. */
  const member = async (login: string, o: { role?: "MEMBER" | "READER"; grant?: boolean; link?: boolean; access?: boolean } = {}) => {
    const { user, member: m } = await addMember(db(), w.ws.id, `${login}@acme.test`, o.role ?? "MEMBER");
    await db().projectMember.create({ data: { projectId: project.id, memberId: m.id } });
    if (o.grant !== false) await db().repositoryGrant.create({ data: { memberId: m.id, repositoryId: repo.id, grantedById: w.owner.id, canManageWork: true, canReview: true } });
    let token = "";
    if (o.link !== false) {
      const gh = server.addUser(login);
      server.repo("acme", "web")!.collaborators.set(login, "push");
      await db().user.update({ where: { id: user.id }, data: { githubId: BigInt(gh.id), githubLogin: login } });
      token = server.issueUserToken(login);
      await storeUserTokens(db(), user.id, { accessToken: token, refreshToken: null, expiresInSeconds: null, refreshExpiresInSeconds: null }, userTokenKey()!, new Date());
      if (o.access !== false) await db().githubRepoAccess.create({ data: { userId: user.id, repositoryGithubId: repo.githubId, installationId: BigInt(inst.id), permission: "push", checkedAt: new Date() } });
    }
    return { user, token, viewer: async () => (await loadViewer(db(), user.id, w.ws.id))! as Viewer };
  };
  const item = async (number: number) => {
    server.addWork("acme", "web", { number, title: `item ${number}`, author: "acme-owner" });
    return db().workItem.create({ data: { repositoryId: repo.id, githubId: BigInt(9000 + number), number, type: "ISSUE", title: `item ${number}`, htmlUrl: `https://github.com/acme/web/issues/${number}`, createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN" } });
  };
  const task = async (v: Viewer, title = "Rotate the keys", description = "before friday") => createTask(db(), v, { projectId: project.id, title, description });
  return { w, repo, inst, project, member, item, task };
}

/** Every write the fake saw came from a user token (`ghu_`), and no installation token ever made a non-GET request. */
const onlyUserTokensWrote = () => {
  expect(server.userWrites.every((x) => x.tokenPrefix === "ghu_")).toBe(true);
  expect(server.calls.filter((c) => /^inst:\d+ (POST|PUT|PATCH|DELETE) /.test(c))).toEqual([]);
  expect(server.calls.filter((c) => /^app (POST|PUT|PATCH|DELETE) \/repos\//.test(c)).length).toBeGreaterThanOrEqual(server.userWrites.length);
};
const refused = async (p: Promise<unknown>, reason: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GithubWriteRefusedError);
  expect((e as GithubWriteRefusedError).reason).toBe(reason);
  expect((e as Error).message).toBe(REFUSAL_MESSAGES[reason as keyof typeof REFUSAL_MESSAGES]);
};

describe("create an issue from a task", () => {
  it("happy path: as the person, with the footer, audited, linked, and a sync queued; never the installation token", async () => {
    const W: World = await world();
    const alice = await W.member("alice");
    const v = await alice.viewer();
    const t = await W.task(v);
    const preview = await previewPromotion(db(), v, t.id, W.repo.id);
    expect(preview.refusal).toBeNull();
    expect(preview.body.endsWith("---\nCreated from Mergeport")).toBe(true);
    expect(server.userWrites).toEqual([]); // previewing writes nothing

    const done = await promoteTask(db(), v, t.id, W.repo.id);
    expect(server.userWrites).toHaveLength(1);
    expect(server.userWrites[0]).toMatchObject({ login: "alice", route: "POST /repos/acme/web/issues", tokenPrefix: "ghu_" });
    expect(server.userWrites[0].body.title).toBe("Rotate the keys");
    expect(server.userWrites[0].body.body).toContain("before friday");
    expect(server.userWrites[0].body.body.endsWith("---\nCreated from Mergeport")).toBe(true);
    expect(server.userWrites[0].body.labels).toBeUndefined(); // labels are never written to GitHub
    expect(server.repo("acme", "web")!.work!.find((x) => x.number === done.number)!.author).toBe("alice");
    onlyUserTokensWrote();

    const linked = await db().planningItem.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked).toMatchObject({ workNumber: done.number, workRepoGithubId: W.repo.githubId });
    const audits = await db().auditLog.findMany({ where: { action: "github.write.issue.create" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: W.w.ws.id, actorUserId: alice.user.id, targetId: t.id });
    expect(audits[0].meta).toEqual({ repository: "acme/web", number: done.number });
    expect(JSON.stringify(await db().auditLog.findMany())).not.toContain(alice.token);
    const job = await db().job.findFirst({ where: { type: "sync.item" } });
    expect(job?.payload).toEqual({ repositoryId: W.repo.id, number: done.number });
  });

  it("a task linked by number only is matched to its work item when the mirror learns the issue", async () => {
    const W = await world();
    const alice = await W.member("alice");
    const v = await alice.viewer();
    const t = await W.task(v);
    const { number } = await promoteTask(db(), v, t.id, W.repo.id);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workItemId).toBeNull(); // the user token cannot read in the fake: the mirror has not got it
    const wi = await db().workItem.create({ data: { repositoryId: W.repo.id, githubId: 777n, number, type: "ISSUE", title: "Rotate the keys", htmlUrl: "https://github.com/acme/web/issues/" + number, createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN" } });
    await linkPendingTasks(db(), W.repo.id, number);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workItemId).toBe(wi.id);
  });

  it("is idempotent: a task that follows an issue cannot create another, and a double submit creates one", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    const both = await Promise.allSettled([promoteTask(db(), v, t.id, W.repo.id), promoteTask(db(), v, t.id, W.repo.id)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(server.userWrites).toHaveLength(1);
    await expect(promoteTask(db(), v, t.id, W.repo.id)).rejects.toThrow(/already follows/);
    expect(server.userWrites).toHaveLength(1);
  });

  it("validates the text: control characters and over-long text are refused before GitHub", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const bad = await W.task(v, "ok", "a" + String.fromCharCode(7) + "b");
    await expect(promoteTask(db(), v, bad.id, W.repo.id)).rejects.toBeInstanceOf(ValidationError);
    const long = await W.task(v, "long", "x".repeat(20_001));
    await expect(promoteTask(db(), v, long.id, W.repo.id)).rejects.toThrow(/at most/);
    expect(server.userWrites).toEqual([]);
  });
});

describe("refusals", () => {
  it("ceiling off: nothing is offered and nothing is written, whatever the workspace chose", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    vi.stubEnv("MERGEPORT_GITHUB_WRITES", "off");
    expect(githubWritesCeiling()).toBe(false);
    await refused(promoteTask(db(), v, t.id, W.repo.id), "ceiling-off");
    expect(REFUSAL_MESSAGES["ceiling-off"]).toBe("GitHub writes are not enabled yet");
    expect(await issueDestinationsByProject(db(), v, [W.project.id])).toEqual({});
    const wi = await W.item(5);
    await refused(addComment({ db: db(), v }, wi.id, "hello"), "ceiling-off");
    expect(server.userWrites).toEqual([]);
  });

  it("workspace switch off", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    await refused(promoteTask(db(), v, t.id, W.repo.id), "workspace-off");
    expect(server.userWrites).toEqual([]);
  });

  it("a READER is refused by the role, and a person with GitHub-verified access but no grant is refused", async () => {
    const W = await world();
    const reader = await (await W.member("rita", { role: "READER" })).viewer();
    const ghOnly = await (await W.member("gary", { grant: false })).viewer();
    expect(ghOnly.githubRepoIds).toContain(W.repo.githubId); // GitHub says gary may read it
    const wi = await W.item(5);
    await expect(addComment({ db: db(), v: reader }, wi.id, "hi")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addComment({ db: db(), v: ghOnly }, wi.id, "hi")).rejects.toThrow(/no grant/);
    expect(server.userWrites).toEqual([]);
  });

  it("a person who has not linked GitHub is told to link first", async () => {
    const W = await world();
    const v = await (await W.member("nolink", { link: false })).viewer();
    const wi = await W.item(5);
    await refused(addComment({ db: db(), v }, wi.id, "hi"), "not-linked");
    expect(REFUSAL_MESSAGES["not-linked"]).toMatch(/^Link GitHub first/);
    expect(server.userWrites).toEqual([]);
  });

  it("a link that needs a new sign-in (RELINK), and a token GitHub no longer accepts", async () => {
    const W = await world();
    const a = await W.member("alice");
    const wi = await W.item(5);
    await markRelink(db(), a.user.id);
    await refused(addComment({ db: db(), v: await a.viewer() }, wi.id, "hi"), "relink");

    const b = await W.member("bella");
    server.revokeAllUserTokens("bella");
    await refused(addComment({ db: db(), v: await b.viewer() }, wi.id, "hello"), "relink");
    expect((await db().githubUserToken.findUniqueOrThrow({ where: { userId: b.user.id } })).status).toBe("RELINK");
    expect(server.userWrites).toEqual([]);
  });

  it("no cached repository grant: access not confirmed", async () => {
    const W = await world();
    const v = await (await W.member("noaccess", { access: false })).viewer();
    const wi = await W.item(5);
    await refused(addComment({ db: db(), v }, wi.id, "hi"), "no-access");
  });

  it("a repository of another workspace is not found; one whose installation is not bound (or suspended) is not connected", async () => {
    const W = await world();
    const a = await W.member("alice");
    const v = await a.viewer();
    const other = await workspaceWithOwner(db(), "other@elsewhere.test", "Elsewhere");
    const org = await db().githubOwner.findFirstOrThrow();
    const foreign = await db().repository.create({ data: { workspaceId: other.ws.id, githubId: 999n, ownerId: org.id, name: "theirs", fullName: "acme/theirs", htmlUrl: "https://github.com/acme/theirs", visibility: "PRIVATE", defaultBranch: "main" } });
    const foreignItem = await db().workItem.create({ data: { repositoryId: foreign.id, githubId: 5555n, number: 1, type: "ISSUE", title: "x", htmlUrl: "https://github.com/acme/theirs/issues/1", createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN" } });
    await expect(addComment({ db: db(), v }, foreignItem.id, "hi")).rejects.toBeInstanceOf(NotFoundError);
    // the same installation id but for a repository this workspace has not bound: the gate says not connected
    expect(await writeRefusal(db(), v, { id: foreign.id, githubId: 999n, installationId: BigInt(W.inst.id), isDemo: false, fullName: "acme/theirs", workspaceId: other.ws.id })).toBe("not-connected");

    const wi = await W.item(5);
    await db().githubInstallation.update({ where: { installationId: BigInt(W.inst.id) }, data: { suspendedAt: new Date() } });
    await refused(addComment({ db: db(), v }, wi.id, "hi"), "not-connected");
    await db().githubInstallation.update({ where: { installationId: BigInt(W.inst.id) }, data: { suspendedAt: null } });
    await unbindInstallation(db(), W.w.ws.id, BigInt(W.inst.id));
    await expect(addComment({ db: db(), v }, wi.id, "hi")).rejects.toThrow(); // not visible without a binding: NotFound or not connected, never a write
    expect(server.userWrites).toEqual([]);
  });
});

describe("comments", () => {
  it("posts as the person with the footer, audits it and queues a sync; a twin is a duplicate", async () => {
    const W = await world();
    const a = await W.member("alice");
    const v = await a.viewer();
    const wi = await W.item(5);
    await addComment({ db: db(), v }, wi.id, "looks fine to me");
    expect(server.userWrites).toHaveLength(1);
    expect(server.userWrites[0]).toMatchObject({ login: "alice", route: "POST /repos/acme/web/issues/5/comments" });
    expect(server.userWrites[0].body.body).toBe("looks fine to me\n\n---\nCreated from Mergeport");
    expect(withFooter(server.userWrites[0].body.body)).toBe(server.userWrites[0].body.body); // never twice
    onlyUserTokensWrote();
    const audits = await db().auditLog.findMany({ where: { action: "github.write.comment" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toEqual({ repository: "acme/web", number: 5 });
    expect(await db().job.count({ where: { type: "sync.item" } })).toBe(1);
    await refused(addComment({ db: db(), v }, wi.id, "looks fine to me"), "duplicate");
    await addComment({ db: db(), v }, wi.id, "a different comment");
    expect(server.userWrites).toHaveLength(2);
  });

  it("validates: empty, control characters, too long", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const wi = await W.item(5);
    await expect(addComment({ db: db(), v }, wi.id, "   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(addComment({ db: db(), v }, wi.id, "bad\u0007text")).rejects.toBeInstanceOf(ValidationError);
    await expect(addComment({ db: db(), v }, wi.id, "y".repeat(20_001))).rejects.toThrow(/at most/);
    expect(server.userWrites).toEqual([]);
  });

  it("budgets: 20 per person per hour, and a workspace budget", async () => {
    const W = await world();
    const a = await W.member("alice");
    const b = await W.member("bob");
    const wi = await W.item(5);
    const va = await a.viewer();
    for (let i = 0; i < 19; i++) await take(db(), userWriteKey(a.user.id), 20, 3_600_000); // 19 already spent this hour
    await addComment({ db: db(), v: va }, wi.id, "the twentieth");
    await refused(addComment({ db: db(), v: va }, wi.id, "one too many"), "rate-user");
    expect(server.userWrites).toHaveLength(1);
    // another person is not held back by alice's budget
    await addComment({ db: db(), v: await b.viewer() }, wi.id, "bob can still write");
    expect(server.userWrites).toHaveLength(2);
    // the workspace budget: 2 of 100 used, fill the rest
    for (let i = 0; i < 98; i++) await take(db(), workspaceWriteKey(W.w.ws.id), 100, 3_600_000);
    await refused(addComment({ db: db(), v: await b.viewer() }, wi.id, "workspace is full"), "rate-workspace");
    expect(server.userWrites).toHaveLength(2);
    expect(userWriteKey("x")).toMatch(/^ghwrite:user:/);
  });
});

describe("GitHub's own answers", () => {
  it("403 (and an App without the permission) says what to do, writes a failure audit and frees the lock for a retry", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    server.appLacksWritePermission = true;
    const e = await promoteTask(db(), v, t.id, W.repo.id).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(GithubWriteError);
    expect((e as Error).message).toMatch(/accept the new permissions/);
    const failed = await db().auditLog.findMany({ where: { action: "github.write.issue.create.failed" } });
    expect(failed).toHaveLength(1);
    expect(failed[0].meta).toMatchObject({ repository: "acme/web", reason: "forbidden", status: 403 });
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workNumber).toBeNull();
    server.appLacksWritePermission = false;
    expect((await promoteTask(db(), v, t.id, W.repo.id)).number).toBeGreaterThan(0); // the lock was released by the failure
  });

  it.each([
    [404, /could not find/],
    [410, /deleted or moved/],
    [422, /did not accept the text/],
  ])("%i on a comment is explained", async (status, text) => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const wi = await W.item(5);
    server.failNext(/POST \/repos\/acme\/web\/issues\/5\/comments/, status, "nope");
    await expect(addComment({ db: db(), v }, wi.id, "hello")).rejects.toThrow(text);
    expect(await db().auditLog.count({ where: { action: "github.write.comment.failed" } })).toBe(1);
    expect(server.userWrites).toEqual([]);
  });

  it("410 on an issue means issues are off for the repository", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    server.failNext(/POST \/repos\/acme\/web\/issues$/, 410, "Issues are disabled for this repo");
    await expect(promoteTask(db(), v, t.id, W.repo.id)).rejects.toThrow(/Issues are turned off/);
  });

  it("a person who lost access on GitHub gets GitHub's 404, explained", async () => {
    const W = await world();
    const a = await W.member("alice");
    const wi = await W.item(5);
    server.revoke("acme", "web", "alice");
    await expect(addComment({ db: db(), v: await a.viewer() }, wi.id, "hi")).rejects.toThrow(/could not find/);
  });
});

describe("settings and configuration", () => {
  it("the workspace switch is for owners and administrators, audited, and only while the ceiling is on", async () => {
    const W = await world();
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    const m = await (await W.member("alice")).viewer();
    await expect(setWorkspaceGithubWrites(db(), m, true)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setWorkspaceGithubWrites(db(), W.w.viewer, true)).toBe(true);
    expect(await setWorkspaceGithubWrites(db(), W.w.viewer, true)).toBe(false); // no change, no second audit row
    expect(await db().auditLog.count({ where: { action: "github.writes.enable" } })).toBe(1);
    expect(await githubWritesView(db(), W.w.ws.id)).toEqual({ ceiling: true, enabled: true });
    await setWorkspaceGithubWrites(db(), W.w.viewer, false);
    expect(await db().auditLog.count({ where: { action: "github.writes.disable" } })).toBe(1);
    vi.stubEnv("MERGEPORT_GITHUB_WRITES", "off");
    await expect(setWorkspaceGithubWrites(db(), W.w.viewer, true)).rejects.toBeInstanceOf(ValidationError);
    expect(await githubWritesView(db(), W.w.ws.id)).toEqual({ ceiling: false, enabled: false });
  });

  it("the ceiling defaults to off and the hosted configuration check validates it", () => {
    expect(githubWritesCeiling({})).toBe(false);
    expect(githubWritesCeiling({ MERGEPORT_GITHUB_WRITES: "ON" })).toBe(true);
    expect(githubWritesSettingProblem(undefined, false)).toBeNull();
    expect(githubWritesSettingProblem("off", false)).toBeNull();
    expect(githubWritesSettingProblem("maybe", true)).toMatch(/on or off/);
    expect(githubWritesSettingProblem("on", false)).toMatch(/MERGEPORT_ENCRYPTION_KEY/);
    expect(githubWritesSettingProblem("on", true)).toBeNull();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://mergeport.example.com");
    vi.stubEnv("MERGEPORT_GITHUB_WRITES", "maybe");
    expect(hostedConfigProblems().some((p) => /MERGEPORT_GITHUB_WRITES must be on or off/.test(p))).toBe(true);
    vi.stubEnv("MERGEPORT_GITHUB_WRITES", "on");
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    expect(hostedConfigProblems().some((p) => /needs MERGEPORT_ENCRYPTION_KEY/.test(p))).toBe(true);
  });
});
