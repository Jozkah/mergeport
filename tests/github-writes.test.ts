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
import { addComment, createIssue, editComment, editIssueBody } from "@/lib/services/work-actions";
import { mayEditComment } from "@/lib/github/writes";
import { portForSync } from "@/lib/github/factory";
import { syncItem } from "@/lib/sync/repository";
import { updateTask } from "@/lib/services/tasks";

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

/** What the confirm sheet does: preview, then confirm with the fingerprint of what was shown. */
const promote = async (v: Viewer, taskId: string, repositoryId: string) => {
  const p = await previewPromotion(db(), v, taskId, repositoryId);
  return promoteTask(db(), v, taskId, repositoryId, undefined, p.fingerprint);
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

    const done = await promote(v, t.id, W.repo.id);
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
    const { number } = await promote(v, t.id, W.repo.id);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workItemId).toBeNull(); // the user token cannot read in the fake: the mirror has not got it
    const wi = await db().workItem.create({ data: { repositoryId: W.repo.id, githubId: 777n, number, type: "ISSUE", title: "Rotate the keys", htmlUrl: "https://github.com/acme/web/issues/" + number, createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN" } });
    await linkPendingTasks(db(), W.repo.id, number);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workItemId).toBe(wi.id);
  });

  it("is idempotent: a task that follows an issue cannot create another, and a double submit creates one", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    const both = await Promise.allSettled([promote(v, t.id, W.repo.id), promote(v, t.id, W.repo.id)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(server.userWrites).toHaveLength(1);
    await expect(promote(v, t.id, W.repo.id)).rejects.toThrow(/already follows/);
    expect(server.userWrites).toHaveLength(1);
  });

  it("validates the text: control characters and over-long text are refused before GitHub", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const bad = await W.task(v, "ok", "a" + String.fromCharCode(7) + "b");
    await expect(promote(v, bad.id, W.repo.id)).rejects.toBeInstanceOf(ValidationError);
    const long = await W.task(v, "long", "x".repeat(20_001));
    await expect(promote(v, long.id, W.repo.id)).rejects.toThrow(/at most/);
    expect(server.userWrites).toEqual([]);
  });
});

describe("review fixes", () => {
  it("linkPendingTasks never links a task of another workspace that tracks the same repository id and issue number", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const mine = await W.task(v);
    const other = await workspaceWithOwner(db(), "other@elsewhere.test", "Elsewhere");
    const org = await db().githubOwner.findFirstOrThrow();
    const theirRepo = await db().repository.create({ data: { workspaceId: other.ws.id, githubId: W.repo.githubId, ownerId: org.id, name: "web", fullName: "acme/web", htmlUrl: "https://github.com/acme/web", visibility: "PRIVATE", defaultBranch: "main" } });
    const theirProject = await db().project.create({ data: { workspaceId: other.ws.id, name: "Theirs", slug: "theirs" } });
    await createColumnsForProject(db(), theirProject.id);
    const theirMember = await db().member.findFirstOrThrow({ where: { workspaceId: other.ws.id, userId: other.owner.id } });
    await db().projectMember.create({ data: { projectId: theirProject.id, memberId: theirMember.id } });
    const theirs = await createTask(db(), other.viewer, { projectId: theirProject.id, title: "theirs" });
    for (const id of [mine.id, theirs.id]) await db().planningItem.update({ where: { id }, data: { workRepoGithubId: W.repo.githubId, workNumber: 7 } });
    const wi = await db().workItem.create({ data: { repositoryId: W.repo.id, githubId: 1234n, number: 7, type: "ISSUE", title: "x", htmlUrl: "https://github.com/acme/web/issues/7", createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN" } });
    await linkPendingTasks(db(), W.repo.id, 7);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: mine.id } })).workItemId).toBe(wi.id);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: theirs.id } })).workItemId).toBeNull();
    expect(theirRepo.id).not.toBe(W.repo.id);
  });

  it("posts what the sheet showed: an edit between preview and confirm is refused, a fresh preview works, a missing hash is refused", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    const shown = await previewPromotion(db(), v, t.id, W.repo.id);
    await updateTask(db(), v, t.id, { description: "changed after the preview" });
    await expect(promoteTask(db(), v, t.id, W.repo.id, undefined, shown.fingerprint)).rejects.toThrow("The task changed. Review it again.");
    await expect(promoteTask(db(), v, t.id, W.repo.id)).rejects.toThrow("The task changed. Review it again.");
    expect(server.userWrites).toEqual([]);
    const again = await previewPromotion(db(), v, t.id, W.repo.id);
    expect(again.fingerprint).not.toBe(shown.fingerprint);
    await promoteTask(db(), v, t.id, W.repo.id, undefined, again.fingerprint);
    expect(server.userWrites[0].body.body).toContain("changed after the preview");
  });

  it("a network failure may have landed: the lock stays, a retry is a duplicate, and the message says to check GitHub", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    server.loseResponseNext(/POST \/repos\/acme\/web\/issues$/);
    await expect(promote(v, t.id, W.repo.id)).rejects.toThrow(/could not confirm.*Check GitHub before retrying/);
    expect(server.userWrites).toHaveLength(1); // it was applied, the answer was lost
    await refused(promote(v, t.id, W.repo.id), "duplicate");
    expect(server.userWrites).toHaveLength(1);
    // a comment behaves the same
    const wi = await W.item(5);
    server.loseResponseNext(/POST \/repos\/acme\/web\/issues\/5\/comments$/);
    await expect(addComment({ db: db(), v }, wi.id, "hello")).rejects.toThrow(/could not confirm/);
    await refused(addComment({ db: db(), v }, wi.id, "hello"), "duplicate");
    expect(server.userWrites).toHaveLength(2);
  });

  it("the task is linked right after GitHub created the issue, so a later failure cannot leave it unlinked or allow a second issue", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    vi.spyOn(db().taskComment, "create").mockRejectedValueOnce(new Error("db went away"));
    await expect(promote(v, t.id, W.repo.id)).rejects.toThrow("db went away");
    expect(server.userWrites).toHaveLength(1);
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workNumber).not.toBeNull();
    await expect(promote(v, t.id, W.repo.id)).rejects.toThrow(/already follows/);
    expect(server.userWrites).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("ceiling off: nothing is offered and nothing is written, whatever the workspace chose", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    vi.stubEnv("MERGEPORT_GITHUB_WRITES", "off");
    expect(githubWritesCeiling()).toBe(false);
    await refused(promote(v, t.id, W.repo.id), "ceiling-off");
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
    await refused(promote(v, t.id, W.repo.id), "workspace-off");
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

  it("keeps the line breaks the person typed (a form posts CRLF)", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const wi = await W.item(5);
    await addComment({ db: db(), v }, wi.id, "line one\r\nline two\r\n\r\nnew paragraph");
    expect(server.userWrites[0].body.body).toBe("line one\nline two\n\nnew paragraph\n\n---\nCreated from Mergeport");
  });
});

describe("edits", () => {
  /** A conversation comment on GitHub and its mirror row, written by `login`. */
  const comment = async (wi: { id: string; number: number }, login: string, body: string, kind: "ISSUE_COMMENT" | "REVIEW_COMMENT" = "ISSUE_COMMENT") => {
    const w = server.repo("acme", "web")!.work!.find((x) => x.number === wi.number)!;
    const id = 77_000 + (w.comments?.length ?? 0);
    (w.comments ??= []).push({ id, user: login, body });
    const u = await db().user.findFirst({ where: { githubLogin: login } });
    return db().workItemComment.create({ data: { workItemId: wi.id, githubId: BigInt(id), kind, authorLogin: login, authorGithubId: u?.githubId ?? null, body, createdAtGh: new Date(), updatedAtGh: new Date() } });
  };

  it("description: as the person, the exact text (line breaks kept, no footer added), mirror updated at once, audited, and a sync keeps it", async () => {
    const W = await world();
    const a = await W.member("alice");
    const v = await a.viewer();
    const wi = await W.item(5);
    expect(await editIssueBody({ db: db(), v }, wi.id, "first\r\nsecond\r\n\r\nnew paragraph")).toEqual({ changed: true });
    expect(server.userWrites).toHaveLength(1);
    expect(server.userWrites[0]).toMatchObject({ login: "alice", route: "PATCH /repos/acme/web/issues/5", tokenPrefix: "ghu_" });
    expect(server.userWrites[0].body).toEqual({ body: "first\nsecond\n\nnew paragraph" });
    onlyUserTokensWrote();
    expect(server.repo("acme", "web")!.work!.find((x) => x.number === 5)!.body).toBe("first\nsecond\n\nnew paragraph");
    expect((await db().workItem.findUniqueOrThrow({ where: { id: wi.id } })).body).toBe("first\nsecond\n\nnew paragraph");
    expect(await db().auditLog.count({ where: { action: "github.write.issue.edit" } })).toBe(1);
    expect(await db().job.count({ where: { type: "sync.item" } })).toBe(1);
    // the mirror's next sync (installation token) reads the same text back
    await syncItem(db(), (await portForSync(db(), W.repo.id))!, W.repo.id, 5);
    expect((await db().workItem.findUniqueOrThrow({ where: { id: wi.id } })).body).toBe("first\nsecond\n\nnew paragraph");
    // the same text again is a no-op: nothing sent, no budget spent
    expect(await editIssueBody({ db: db(), v }, wi.id, "first\nsecond\n\nnew paragraph")).toEqual({ changed: false });
    expect(server.userWrites).toHaveLength(1);
  });

  it("a footer already in the text stays exactly once; none is added to text without one", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const wi = await W.item(5);
    await db().workItem.update({ where: { id: wi.id }, data: { body: "old\n\n---\nCreated from Mergeport" } });
    await editIssueBody({ db: db(), v }, wi.id, "new\n\n---\nCreated from Mergeport");
    expect(server.userWrites[0].body.body).toBe("new\n\n---\nCreated from Mergeport");
    const c = await comment(wi, "alice", "mine");
    await editComment({ db: db(), v }, wi.id, c.id, "still mine");
    expect(server.userWrites[1].body.body).toBe("still mine");
  });

  it("comment: only the author (or a maintainer) may, only conversation comments, as the person", async () => {
    const W = await world();
    const a = await W.member("alice");
    const b = await W.member("bob");
    const va = await a.viewer();
    const wi = await W.item(5);
    const c = await comment(wi, "alice", "typo hree");
    await expect(editComment({ db: db(), v: await b.viewer() }, wi.id, c.id, "bob was here")).rejects.toBeInstanceOf(ForbiddenError);
    expect(server.userWrites).toEqual([]);
    await expect(editComment({ db: db(), v: va }, wi.id, c.id, "   ")).rejects.toBeInstanceOf(ValidationError);
    expect(await editComment({ db: db(), v: va }, wi.id, c.id, "typo here\r\nand more")).toEqual({ changed: true });
    expect(server.userWrites[0]).toMatchObject({ login: "alice", route: `PATCH /repos/acme/web/issues/comments/${c.githubId}` });
    expect(server.userWrites[0].body).toEqual({ body: "typo here\nand more" });
    expect(server.repo("acme", "web")!.work!.find((x) => x.number === 5)!.comments![0].body).toBe("typo here\nand more");
    expect((await db().workItemComment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe("typo here\nand more");
    expect(await db().auditLog.count({ where: { action: "github.write.comment.edit" } })).toBe(1);
    // GitHub's cached answer "maintain" lets bob edit anybody's comment from here; GitHub agrees (bob has write access)
    await db().githubRepoAccess.updateMany({ where: { userId: b.user.id }, data: { permission: "maintain" } });
    await editComment({ db: db(), v: await b.viewer() }, wi.id, c.id, "fixed by a maintainer");
    expect(server.userWrites[1]).toMatchObject({ login: "bob" });
    // review and inline comments are not editable here
    const rc = await comment(wi, "alice", "inline", "REVIEW_COMMENT");
    await expect(editComment({ db: db(), v: va }, wi.id, rc.id, "x")).rejects.toThrow(/Only conversation comments/);
    // a comment of another item is not found through this item
    const other = await W.item(6);
    await expect(editComment({ db: db(), v: va }, other.id, c.id, "x")).rejects.toBeInstanceOf(NotFoundError);
    expect(server.userWrites).toHaveLength(2);
  });

  it("goes through the same gate: switch off, no link, no cached access are refused before GitHub", async () => {
    const W = await world();
    const wi = await W.item(5);
    const nolink = await (await W.member("nolink", { link: false })).viewer();
    await refused(editIssueBody({ db: db(), v: nolink }, wi.id, "x"), "not-linked");
    const noaccess = await (await W.member("noaccess", { access: false })).viewer();
    await refused(editIssueBody({ db: db(), v: noaccess }, wi.id, "x"), "no-access");
    const a = await W.member("alice");
    const c = await comment(wi, "alice", "mine");
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    await refused(editIssueBody({ db: db(), v: await a.viewer() }, wi.id, "x"), "workspace-off");
    await refused(editComment({ db: db(), v: await a.viewer() }, wi.id, c.id, "x"), "workspace-off");
    expect(server.userWrites).toEqual([]);
  });

  it("GitHub's refusal (no write access, not the author) is explained and audited; nothing changes locally", async () => {
    const W = await world();
    const a = await W.member("alice");
    const wi = await W.item(5);
    server.repo("acme", "web")!.collaborators.set("alice", "pull");
    await expect(editIssueBody({ db: db(), v: await a.viewer() }, wi.id, "hijack")).rejects.toThrow(/GitHub refused this edit/);
    expect(await db().auditLog.count({ where: { action: "github.write.issue.edit.failed" } })).toBe(1);
    expect((await db().workItem.findUniqueOrThrow({ where: { id: wi.id } })).body).toBeNull();
  });

  it("a demo repository edits locally without the gate", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const wi = await W.item(5);
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    await db().repository.update({ where: { id: W.repo.id }, data: { isDemo: true } });
    await editIssueBody({ db: db(), v }, wi.id, "demo\ntext");
    expect((await db().workItem.findUniqueOrThrow({ where: { id: wi.id } })).body).toBe("demo\ntext");
    expect(server.userWrites).toEqual([]);
  });

  it("mayEditComment: a real repository matches the linked GitHub identity, never the Mergeport login", () => {
    const c = { kind: "ISSUE_COMMENT", authorLogin: "alice", authorGithubId: null };
    expect(mayEditComment(c, { login: "alice", githubLogin: null, githubId: null }, false, false)).toBe(false);
    expect(mayEditComment(c, { login: "x", githubLogin: "alice", githubId: 5n }, false, false)).toBe(true);
    expect(mayEditComment(c, { login: "alice", githubLogin: null, githubId: null }, true, false)).toBe(true);
    expect(mayEditComment({ ...c, kind: "REVIEW" }, { login: "x", githubLogin: "alice", githubId: 5n }, false, true)).toBe(false);
  });
});

describe("create an issue from the new issue page", () => {
  it("goes through the write gate: as the person, with the footer and line breaks, no labels, audited, linked to its work item; a twin is a duplicate", async () => {
    const W = await world();
    const alice = await W.member("alice");
    const v = await alice.viewer();
    const done = await createIssue({ db: db(), v }, W.repo.id, { title: "  Broken login  ", body: "steps:\r\n1. open\r\n2. fail", labels: ["bug"] });
    expect(server.userWrites).toHaveLength(1);
    expect(server.userWrites[0]).toMatchObject({ login: "alice", route: "POST /repos/acme/web/issues", tokenPrefix: "ghu_" });
    expect(server.userWrites[0].body.title).toBe("Broken login");
    expect(server.userWrites[0].body.body).toBe("steps:\n1. open\n2. fail\n\n---\nCreated from Mergeport");
    expect(server.userWrites[0].body.labels).toBeUndefined();
    onlyUserTokensWrote();
    // The fake does not serve reads with a user token, so the immediate sync misses and the queued sync.item fills the mirror.
    expect(done.workItemId).toBeNull();
    expect((await db().job.findFirst({ where: { type: "sync.item" } }))?.payload).toEqual({ repositoryId: W.repo.id, number: done.number });
    const audits = await db().auditLog.findMany({ where: { action: "github.write.issue.create" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: alice.user.id, targetType: "Repository", targetId: W.repo.id });
    await refused(createIssue({ db: db(), v }, W.repo.id, { title: "Broken login", body: "steps:\n1. open\n2. fail" }), "duplicate");
    expect(server.userWrites).toHaveLength(1);
  });

  it("is refused like any other write (workspace switch off) and validates the text before GitHub", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    await expect(createIssue({ db: db(), v }, W.repo.id, { title: "   " })).rejects.toThrow(/title/);
    await expect(createIssue({ db: db(), v }, W.repo.id, { title: "a\u0007b" })).rejects.toBeInstanceOf(ValidationError);
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    await refused(createIssue({ db: db(), v }, W.repo.id, { title: "Off" }), "workspace-off");
    expect(server.userWrites).toEqual([]);
  });

  it("a demo repository still works without the gate, labels included", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    await db().workspace.update({ where: { id: W.w.ws.id }, data: { githubWritesEnabled: false } });
    await db().repository.update({ where: { id: W.repo.id }, data: { isDemo: true } });
    const done = await createIssue({ db: db(), v }, W.repo.id, { title: "Demo", body: "a\nb", labels: ["bug"] });
    const wi = await db().workItem.findUniqueOrThrow({ where: { id: done.workItemId! } });
    expect(wi).toMatchObject({ number: done.number, title: "Demo", body: "a\nb", labelNames: expect.stringContaining("bug") });
    expect(server.userWrites).toEqual([]);
  });
});

describe("GitHub's own answers", () => {
  it("403 (and an App without the permission) says what to do, writes a failure audit and frees the lock for a retry", async () => {
    const W = await world();
    const v = await (await W.member("alice")).viewer();
    const t = await W.task(v);
    server.appLacksWritePermission = true;
    const e = await promote(v, t.id, W.repo.id).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(GithubWriteError);
    expect((e as Error).message).toMatch(/accept the new permissions/);
    const failed = await db().auditLog.findMany({ where: { action: "github.write.issue.create.failed" } });
    expect(failed).toHaveLength(1);
    expect(failed[0].meta).toMatchObject({ repository: "acme/web", reason: "forbidden", status: 403 });
    expect((await db().planningItem.findUniqueOrThrow({ where: { id: t.id } })).workNumber).toBeNull();
    server.appLacksWritePermission = false;
    expect((await promote(v, t.id, W.repo.id)).number).toBeGreaterThan(0); // the lock was released by the failure
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
    await expect(promote(v, t.id, W.repo.id)).rejects.toThrow(/Issues are turned off/);
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
