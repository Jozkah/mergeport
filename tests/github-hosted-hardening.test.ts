import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import { bind, hostedGithub, releaseApp, useApp } from "./github-hosted-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { loadViewer, repoWhere, type Viewer } from "@/lib/authz/viewer";
import { ForbiddenError } from "@/lib/errors";
import { GithubNotConnectedError, GithubWritesDisabledError } from "@/lib/github/hosted";
import { loadBoundInstallation } from "@/lib/github/binding";
import { portForSync } from "@/lib/github/factory";
import { guardSourceBudget } from "@/lib/github/budget";
import { GithubError } from "@/lib/github/port";
import { trackInstallationRepos } from "@/lib/services/installation-repos";
import { removeFromTracking, trackLocally, type RepoMeta } from "@/lib/services/repositories";
import { revokeRepositories } from "@/lib/services/grants";
import { removeMember } from "@/lib/services/members";
import { digestVisibilityKey, getDigest, latestDigest, listDigestDays } from "@/lib/services/digest";
import { reviewCapacity } from "@/lib/services/capacity";
import { listWorkItems, searchGlobal } from "@/lib/services/queries";
import { syncRepository } from "@/lib/sync/repository";
import { portFor } from "@/lib/services/git-view";
import { withViewer } from "@/lib/api-viewer";

/**
 * Hardening of the hosted GitHub phase: members cannot grant themselves access (import by URL) or revoke everyone's (untrack); a public
 * repository turning private loses its grants; stored digests never outlive access; the connect page and interactive reads cost GitHub
 * calls only when allowed and within the installation's budget; review capacity and queues use GitHub identity only.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
const db = () => state.db!;
let gh: ReturnType<typeof hostedGithub>;
let inst: { id: number; accountLogin: string; accountId: number };

beforeEach(async () => {
  state.db = createTestPrisma(`github-hosted-hardening-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("DEMO_MODE", "false");
  gh = hostedGithub();
  await gh.create("pub", false);
  gh.server.addWork("acme", "pub", { number: 1, title: "Public issue", updatedAt: "2026-11-01T10:00:00Z" });
  const i = gh.server.addInstallation("acme", { repos: ["acme/pub"] });
  inst = { id: i.id, accountLogin: "acme", accountId: i.accountId };
  useApp(gh.server, gh.app);
});
afterEach(async () => {
  releaseApp();
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});

const meta = (githubId: bigint, name: string): RepoMeta => ({ githubId, fullName: `x/${name}`, name, htmlUrl: `https://github.com/x/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 900n, login: "x", type: "ORGANIZATION" } });
const signIn = async (userId: string, workspaceId: string) => {
  const { token } = await createSession(db(), userId, new Date(), workspaceId);
  state.jar.set(SESSION_COOKIE, { value: token, options: {} });
};
async function world() {
  const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
  await bind(db(), w.ws.id, inst);
  const member = await addMember(db(), w.ws.id, "member@acme.test", "MEMBER");
  const [r] = await trackInstallationRepos(db(), w.viewer, [String(gh.server.repo("acme", "pub")!.id)]);
  const grant = (memberId: string) => db().repositoryGrant.create({ data: { memberId, repositoryId: r.id, grantedById: w.owner.id, canManageWork: true, canReview: true } });
  const digest = async (userId: string) => db().dailyDigest.create({ data: { workspaceId: w.ws.id, userId, day: "2026-11-09", payload: { version: 1, secret: "PRIVATE-TITLE" } as never, visibilityKey: await digestVisibilityKey(db(), (await loadViewer(db(), userId, w.ws.id))!) } });
  return { w, member, r, grant, digest, mv: await member.viewer() };
}

describe("F1: a member cannot give themselves access", () => {
  it("import by URL is refused for a member in hosted mode and creates no grant", async () => {
    const x = await world();
    await signIn(x.member.user.id, x.w.ws.id);
    const { importPublicAction } = await import("@/app/actions");
    const fd = new FormData();
    fd.set("repo", "acme/pub");
    await expect(importPublicAction(fd)).rejects.toBeDefined(); // the same 404 as any admin-only action
    expect(await db().repositoryGrant.count()).toBe(0);
  });

  it("trackLocally in hosted mode refuses a member and, for an administrator, creates no grant and does not re-activate an untracked repository", async () => {
    const x = await world();
    await expect(trackLocally(db(), x.mv, [meta(5n, "a")])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db().repository.count({ where: { githubId: 5n } })).toBe(0);
    const [created] = await trackLocally(db(), x.w.viewer, [meta(6n, "b")]);
    expect(await db().repositoryGrant.count({ where: { repositoryId: created.id } })).toBe(0);
    await removeFromTracking(db(), x.w.viewer, created.id);
    const [again] = await trackLocally(db(), x.w.viewer, [meta(6n, "b")]);
    expect(again.trackingStatus).toBe("REMOVED");
    // A revoked grant is not revived either.
    const g = await x.grant(x.member.member.id);
    await db().repositoryGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    await trackLocally(db(), x.w.viewer, [meta(x.r.githubId, "pub")]).catch(() => {});
    expect((await db().repositoryGrant.findUniqueOrThrow({ where: { id: g.id } })).revokedAt).not.toBeNull();
  });

  it("a public repository turning private loses every grant, its holders' digests, and is audited", async () => {
    const x = await world();
    await x.grant(x.member.member.id);
    await x.digest(x.member.user.id);
    expect((await listWorkItems(db(), x.mv, { state: "ALL" })).total).toBe(0); // not synced yet
    gh.server.repo("acme", "pub")!.private = true;
    const port = (await portForSync(db(), x.r.id))!;
    await syncRepository(db(), port, x.r.id, { full: true });
    expect((await db().repository.findUniqueOrThrow({ where: { id: x.r.id } })).visibility).toBe("PRIVATE");
    expect(await db().repositoryGrant.count({ where: { repositoryId: x.r.id, revokedAt: null } })).toBe(0);
    expect(await db().dailyDigest.count()).toBe(0);
    const row = await db().auditLog.findFirstOrThrow({ where: { action: "repository.visibility-flip" } });
    expect(JSON.stringify(row.meta)).not.toContain("Public issue");
    const mv = await x.member.viewer();
    expect(await db().repository.count({ where: repoWhere(mv) })).toBe(0);
    expect((await listWorkItems(db(), mv, { state: "ALL" })).rows).toHaveLength(0);
    expect((await searchGlobal(db(), mv, "Public")).workItems).toHaveLength(0);
    expect(await db().repository.count({ where: repoWhere(x.w.viewer) })).toBe(1); // the owner still sees it
  });
});

describe("F2: only an administrator untracks (hosted)", () => {
  it("a member cannot, by service or action; an administrator can", async () => {
    const x = await world();
    await x.grant(x.member.member.id);
    await expect(removeFromTracking(db(), x.mv, x.r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await signIn(x.member.user.id, x.w.ws.id);
    const { untrackRepositoryAction } = await import("@/app/actions");
    const fd = new FormData();
    fd.set("repositoryId", x.r.id);
    await expect(untrackRepositoryAction(fd)).rejects.toBeDefined();
    expect((await db().repository.findUniqueOrThrow({ where: { id: x.r.id } })).trackingStatus).toBe("ACTIVE");
    await removeFromTracking(db(), x.w.viewer, x.r.id);
    expect((await db().repository.findUniqueOrThrow({ where: { id: x.r.id } })).trackingStatus).toBe("REMOVED");
  });
});

describe("F3: a stored digest never outlives the access it was made from", () => {
  const gone = async (x: Awaited<ReturnType<typeof world>>, v: Viewer) => {
    expect(await getDigest(db(), v, "2026-11-09")).toBeNull();
    expect(await latestDigest(db(), v)).toBeNull();
    expect(await listDigestDays(db(), v)).toEqual([]);
    expect(x).toBeDefined();
  };
  it("revoking a grant", async () => {
    const x = await world();
    await x.grant(x.member.member.id);
    await x.digest(x.member.user.id);
    expect(await getDigest(db(), x.mv, "2026-11-09")).not.toBeNull();
    await revokeRepositories(db(), x.w.viewer, x.member.member.id, [x.r.id]);
    await gone(x, x.mv);
  });
  it("untracking the repository", async () => {
    const x = await world();
    await x.grant(x.member.member.id);
    await x.digest(x.member.user.id);
    await removeFromTracking(db(), x.w.viewer, x.r.id);
    await gone(x, x.mv);
  });
  it("removing the member", async () => {
    const x = await world();
    await x.digest(x.member.user.id);
    await removeMember(db(), x.w.viewer, x.member.member.id);
    expect(await db().dailyDigest.count({ where: { userId: x.member.user.id } })).toBe(0);
  });
});

describe("F4: GitHub calls cost something only when allowed", () => {
  it("a member's view of Connect repositories makes no GitHub call; an administrator's does", async () => {
    const x = await world();
    const { HostedConnect } = await import("@/components/repos/HostedConnect");
    const before = gh.server.calls.length;
    await HostedConnect({ viewer: x.mv });
    expect(gh.server.calls.length).toBe(before);
    await HostedConnect({ viewer: x.w.viewer });
    expect(gh.server.calls.length).toBeGreaterThan(before);
  });

  it("an interactive read spends and records the installation's budget, and stops when it is spent", async () => {
    const x = await world();
    const port = await portFor(db(), x.r.id);
    await port.getRepository("acme", "pub");
    await vi.waitFor(async () => expect(await db().rateLimitState.findUnique({ where: { key: `installation:${inst.id}` } })).not.toBeNull());
    await db().rateLimitState.update({ where: { key: `installation:${inst.id}` }, data: { remaining: 0, resetAt: new Date(Date.now() + 3_600_000) } });
    await expect(portFor(db(), x.r.id)).rejects.toBeInstanceOf(GithubError);
    await expect(guardSourceBudget(db(), `installation:${inst.id + 1}`)).resolves.toBeUndefined();
  });
});

describe("F5: capacity is by GitHub account", () => {
  it("a mailbox name matching a reviewer on GitHub is not counted; a linked member is", async () => {
    const x = await world();
    const alice = await addMember(db(), x.w.ws.id, "alice@elsewhere.test", "MEMBER");
    const carolUser = await person(db(), "carol@acme.test", { githubId: 3003n });
    await db().member.create({ data: { workspaceId: x.w.ws.id, userId: carolUser.id, role: "MEMBER", status: "ACTIVE" } });
    const wi = await db().workItem.create({ data: { repositoryId: x.r.id, githubId: 4004n, number: 9, type: "PULL_REQUEST", title: "PR", htmlUrl: "https://x/9", createdAtGh: new Date(), updatedAtGh: new Date(), authorLogin: "someone", headSha: "d4" } });
    for (const ref of ["alice", "carol"]) await db().reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: ref, requestedAt: new Date() } });
    const rows = await reviewCapacity(db(), x.w.viewer);
    expect(rows.find((r) => r.login === "alice")!.queued).toBe(0);
    expect(rows.find((r) => r.login === "carol")!.queued).toBe(1);
    expect(alice.user.id).toBeTruthy();
  });
});

describe("F6: the hosted watchlist", () => {
  it("says it is not available instead of tracking repositories nothing can read", async () => {
    const x = await world();
    await signIn(x.w.owner.id, x.w.ws.id);
    const { watchlistAction } = await import("@/app/actions");
    const r = await watchlistAction({ text: "https://github.com/acme/pub" });
    expect(r).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/Connect repositories/) }));
    expect(await db().repository.count({ where: { workspaceId: x.w.ws.id } })).toBe(1); // only the one tracked through the connection
    expect(await loadBoundInstallation(db(), x.w.ws.id, BigInt(inst.id))).not.toBeNull();
  });
});

describe("G1: API routes answer GitHub-state errors cleanly", () => {
  it("not connected and writes disabled are 409 with plain messages, not a generic 500", async () => {
    const x = await world();
    await signIn(x.w.owner.id, x.w.ws.id);
    const a = await withViewer(async () => {
      throw new GithubNotConnectedError();
    });
    expect(a.status).toBe(409);
    expect((await a.json()).error).toBe("GitHub is not connected for this workspace.");
    const b = await withViewer(async () => {
      throw new GithubWritesDisabledError();
    });
    expect(b.status).toBe(409);
    expect((await b.json()).error).toBe("GitHub writes are not enabled yet.");
  });
});
