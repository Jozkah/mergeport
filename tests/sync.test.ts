import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { GithubError, type RemoteWorkItem } from "@/lib/github/port";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { applyWorkItem, syncFork, syncItem, syncRepository } from "@/lib/sync/repository";
import { enqueue, reclaimStuck, runOne } from "@/lib/jobs";
import { truncateAll } from "@/lib/demo/seed";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { testDb } from "./helpers";

const db = testDb();
const T = (d: number) => new Date(Date.UTC(2026, 9, d));

const meta = (id: bigint, owner: string, name: string, extra: Partial<RepoMeta> = {}): RepoMeta => ({
  githubId: id, fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: id + 1000n, login: owner, type: "ORGANIZATION" }, ...extra,
});
const item = (number: number, o: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({
  githubId: BigInt(500 + number), number, type: "ISSUE", title: `Item ${number}`, body: null, state: "OPEN", draft: false, authorLogin: "dev", authorGithubId: 1n, authorAvatar: null,
  labels: [{ name: "bug", color: "d73a4a" }], assignees: [], milestoneNumber: null, milestoneTitle: null, htmlUrl: `https://x/${number}`, createdAt: T(1), updatedAt: T(2), closedAt: null, mergedAt: null, ...o,
});
const pr = (number: number, o: Partial<RemoteWorkItem> = {}) => item(number, { type: "PULL_REQUEST", headSha: "head1", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", ...o });

let fake: FakeGithub;
let repoId: string;
let wsId: string;

beforeEach(async () => {
  await truncateAll(db);
  fake = new FakeGithub();
  const ws = await db.workspace.create({ data: { name: "ws" } });
  wsId = ws.id;
  const m = meta(1n, "acme", "tool");
  fake.repos.set("acme/tool", m);
  const repo = await upsertRepository(db, ws.id, m);
  repoId = repo.id;
  fake.branches.set("acme/tool", [{ name: "main", sha: "m1", isDefault: true }]);
});

describe("repository sync", () => {
  it("paginates, counts each issue/PR once, and stores discussion, reviews, requests and branches", async () => {
    fake.pageSize = 2;
    fake.items.set("acme/tool", [item(1), item(2), pr(3), pr(4), item(5)]);
    fake.reviews.set("acme/tool#3", [{ githubId: 90n, login: "rev", state: "APPROVED", body: null, commitSha: "head1", submittedAt: T(3) }]);
    fake.requested.set("acme/tool#4", { users: ["someone"], teams: ["org/team"] });
    fake.comments.set("acme/tool#1", [{ githubId: 70n, login: "x", body: "hi", createdAt: T(2), updatedAt: T(2) }]);
    const r = await syncRepository(db, fake, repoId, { now: T(10) });
    expect(r.pages).toBe(3);
    expect(await db.workItem.count({ where: { repositoryId: repoId } })).toBe(5);
    expect(await db.workItem.count({ where: { repositoryId: repoId, type: "PULL_REQUEST" } })).toBe(2);
    expect(await db.workItemComment.count({ where: { kind: "REVIEW" } })).toBe(1);
    expect(await db.reviewRequest.count({ where: { removedAt: null } })).toBe(2);
    expect(await db.branch.count()).toBe(1);
    const repo = await db.repository.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.lastSyncedAt).toEqual(T(10));
  });

  it("is idempotent: syncing twice creates no duplicates", async () => {
    fake.items.set("acme/tool", [item(1), pr(2)]);
    fake.reviews.set("acme/tool#2", [{ githubId: 91n, login: "rev", state: "COMMENTED", body: null, commitSha: "head1", submittedAt: T(3) }]);
    fake.requested.set("acme/tool#2", { users: ["u"], teams: [] });
    fake.comments.set("acme/tool#1", [{ githubId: 70n, login: "x", body: "hi", createdAt: T(2), updatedAt: T(2) }]);
    await syncRepository(db, fake, repoId, { full: true, now: T(10) });
    const counts = async () => [await db.workItem.count(), await db.workItemComment.count(), await db.reviewRequest.count()];
    const first = await counts();
    await syncRepository(db, fake, repoId, { full: true, now: T(11) });
    await syncRepository(db, fake, repoId, { full: true, now: T(12) });
    expect(await counts()).toEqual(first);
  });

  it("downloads conversations only for open and recently active items, and says so for the rest", async () => {
    const old = new Date(Date.UTC(2026, 5, 1));
    fake.items.set("acme/tool", [item(1), pr(2, { state: "MERGED", updatedAt: old, closedAt: old, mergedAt: old }), pr(3, { state: "CLOSED", updatedAt: T(5), closedAt: T(5) })]);
    for (const n of [1, 2, 3]) {
      fake.comments.set(`acme/tool#${n}`, [{ githubId: BigInt(700 + n), login: "x", body: "hi", createdAt: old, updatedAt: old }]);
      fake.reviews.set(`acme/tool#${n}`, [{ githubId: BigInt(800 + n), login: "rev", state: "APPROVED", body: null, commitSha: "head1", submittedAt: old }]);
    }
    const r = await syncRepository(db, fake, repoId, { now: T(10) });
    expect(r.applied).toBe(3);
    expect(r.discussionSkipped).toBe(1);
    const withComments = (await db.workItemComment.findMany({ include: { workItem: true } })).map((c) => c.workItem.number);
    expect(new Set(withComments)).toEqual(new Set([1, 3]));
    expect(await db.workItem.count({ where: { repositoryId: repoId } })).toBe(3); // the old item itself is still known
  });

  it("review requests on merged or closed pull requests are history, not pending work", async () => {
    fake.items.set("acme/tool", [pr(1), pr(2, { state: "MERGED", updatedAt: T(5), closedAt: T(5), mergedAt: T(5) })]);
    fake.requested.set("acme/tool#1", { users: ["someone"], teams: [] });
    fake.requested.set("acme/tool#2", { users: ["someone"], teams: ["org/team"] });
    await syncRepository(db, fake, repoId, { now: T(10) });
    const active = await db.reviewRequest.findMany({ where: { removedAt: null }, include: { workItem: true } });
    expect(active.map((r) => r.workItem.number)).toEqual([1]);
    // an older sync had recorded a request on a PR that has since been merged: the next sync closes it
    const merged = await db.workItem.findFirstOrThrow({ where: { repositoryId: repoId, number: 2 } });
    await db.reviewRequest.create({ data: { workItemId: merged.id, kind: "USER", reviewerRef: "late", requestedAt: T(3) } });
    await syncRepository(db, fake, repoId, { now: T(11) });
    expect((await db.reviewRequest.findMany({ where: { removedAt: null }, include: { workItem: true } })).map((r) => r.workItem.number)).toEqual([1]);
  });

  it("a repeated refresh does not download unchanged closed conversations again", async () => {
    fake.items.set("acme/tool", [item(1), pr(2, { state: "MERGED", updatedAt: T(8), closedAt: T(8), mergedAt: T(8) })]);
    const calls: number[] = [];
    const orig = fake.listIssueComments.bind(fake);
    fake.listIssueComments = async (o: string, r: string, n: number) => { calls.push(n); return orig(o, r, n); };
    await syncRepository(db, fake, repoId, { now: T(10), full: true });
    expect(calls.sort()).toEqual([1, 2]);
    calls.length = 0;
    await syncRepository(db, fake, repoId, { now: T(11), full: true });
    expect(calls).toEqual([1]); // the open item is re-read, the merged one that did not change is not
    fake.items.set("acme/tool", [item(1), pr(2, { state: "MERGED", updatedAt: T(12), closedAt: T(8), mergedAt: T(8) })]);
    calls.length = 0;
    await syncRepository(db, fake, repoId, { now: T(13), full: true });
    expect(calls.sort()).toEqual([1, 2]); // it changed, so it is read again
  });

  it("an older delivery never overwrites a newer snapshot", async () => {
    await applyWorkItem(db, repoId, item(1, { title: "newer", updatedAt: T(5) }));
    const applied = await applyWorkItem(db, repoId, item(1, { title: "older", updatedAt: T(3) }));
    expect(applied).toBe(false);
    expect((await db.workItem.findFirstOrThrow({ where: { number: 1 } })).title).toBe("newer");
  });

  it("GitHub timestamp changes do not overwrite local planning state", async () => {
    const ownerUser = await db.user.create({ data: { githubId: 9n, login: "m" } });
    const owner = await db.member.create({ data: { workspaceId: wsId, userId: ownerUser.id, role: "ADMIN" } });
    const project = await db.project.create({ data: { workspaceId: wsId, name: "P", slug: "p" } });
    const col = await db.planningColumn.create({ data: { projectId: project.id, key: "ready", name: "Ready", position: 0 } });
    await applyWorkItem(db, repoId, item(1, { updatedAt: T(2) }));
    const wi = await db.workItem.findFirstOrThrow({ where: { number: 1 } });
    const card = await db.planningItem.create({ data: { projectId: project.id, columnId: col.id, position: 1, title: "t", workItemId: wi.id, priority: 3, createdById: owner.id } });
    await applyWorkItem(db, repoId, item(1, { updatedAt: T(9), title: "renamed upstream" }));
    const after = await db.planningItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.priority).toBe(3);
    expect(after.columnId).toBe(col.id);
  });

  it("webhook-style single-item refetch uses the API, not the payload", async () => {
    fake.items.set("acme/tool", [pr(7, { title: "from api" })]);
    expect(await syncItem(db, fake, repoId, 7, T(10))).toBe(true);
    expect((await db.workItem.findFirstOrThrow({ where: { number: 7 } })).title).toBe("from api");
  });

  it("rate limit: marks the repo limited and stale, keeps existing data, rethrows with retry info", async () => {
    fake.items.set("acme/tool", [item(1)]);
    await syncRepository(db, fake, repoId, { now: T(10) });
    fake.failNext(new GithubError("rate-limited", "API rate limit exceeded", 120));
    // getRepository consumes the first failure
    await expect(syncRepository(db, fake, repoId, { now: T(11) })).rejects.toMatchObject({ kind: "rate-limited", retryAfterSeconds: 120 });
    const repo = await db.repository.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.rateLimited).toBe(true);
    expect(repo.trackingStatus).toBe("ACTIVE");
    expect(repo.lastSyncedAt).toEqual(T(10)); // not advanced on failure
    expect(await db.workItem.count()).toBe(1); // data retained, not zeroed
  });

  it("permission loss: shows DISCONNECTED with the real reason instead of zero open work", async () => {
    fake.items.set("acme/tool", [item(1)]);
    await syncRepository(db, fake, repoId, { now: T(10) });
    fake.failNext(new GithubError("forbidden", "Resource not accessible by integration"));
    await expect(syncRepository(db, fake, repoId)).rejects.toBeInstanceOf(GithubError);
    const repo = await db.repository.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.trackingStatus).toBe("DISCONNECTED");
    expect(repo.statusDetail).toMatch(/not accessible/);
    expect(await db.workItem.count()).toBe(1);
  });

  it("a removed review request is closed and the reviewer is notified once for a new one", async () => {
    const reviewer = await db.user.create({ data: { githubId: 55n, login: "Rev" } });
    await db.member.create({ data: { workspaceId: wsId, userId: reviewer.id } });
    fake.items.set("acme/tool", [pr(2)]);
    fake.requested.set("acme/tool#2", { users: ["rev"], teams: [] });
    await syncRepository(db, fake, repoId, { full: true, now: T(10) });
    await syncRepository(db, fake, repoId, { full: true, now: T(11) });
    expect(await db.notification.count({ where: { userId: reviewer.id } })).toBe(1);
    fake.items.set("acme/tool", [pr(2, { updatedAt: T(12) })]);
    fake.requested.set("acme/tool#2", { users: [], teams: [] });
    await syncRepository(db, fake, repoId, { full: true, now: T(13) });
    const rq = await db.reviewRequest.findFirstOrThrow();
    expect(rq.removedAt).toEqual(T(13));
  });
});

describe("fork sync", () => {
  async function setup() {
    const up = await upsertRepository(db, wsId, meta(10n, "acme", "core"));
    const fk = await upsertRepository(db, wsId, meta(11n, "me", "core", { isFork: true, parentGithubId: 10n }));
    const map = await db.forkMapping.create({ data: { forkRepoId: fk.id, upstreamRepoId: up.id, forkBranch: "main", upstreamBranch: "main" } });
    fake.branches.set("acme/core", [{ name: "main", sha: "up-tip", isDefault: true }]);
    fake.branches.set("me/core", [{ name: "main", sha: "fork-tip", isDefault: true }]);
    const merged = (n: number) => db.workItem.create({ data: { repositoryId: up.id, githubId: BigInt(n), number: n, type: "PULL_REQUEST", title: `PR ${n}`, state: "MERGED", htmlUrl: "u", mergedAtGh: T(2), createdAtGh: T(1), updatedAtGh: T(2) } });
    return { up, fk, map, merged };
  }

  it("records direction-aware comparison with both tips", async () => {
    const { map } = await setup();
    fake.compares.set("acme/core:main...me:main", { kind: "ok", data: { status: "diverged", ahead_by: 2, behind_by: 3, total_commits: 5, commits_returned: 5, base_sha: "up-tip", head_sha: "" } });
    await syncFork(db, fake, map.id, T(10));
    const c = await db.forkComparison.findFirstOrThrow();
    expect(c).toMatchObject({ status: "diverged", aheadBy: 2, behindBy: 3, baseSha: "up-tip", headSha: "fork-tip" });
  });

  it("deleted branch or inaccessible repo is 'unavailable', not zero", async () => {
    const { map } = await setup();
    await syncFork(db, fake, map.id, T(10)); // fake has no compare => not-found
    const c = await db.forkComparison.findFirstOrThrow();
    expect(c.status).toBe("unavailable");
    expect(c.aheadBy).toBeNull();
  });

  it("merged-PR evidence: ancestry exact, not detected, unknown; titles never count; manual ack survives resync", async () => {
    const { map, merged } = await setup();
    await merged(101);
    await merged(102);
    await merged(103);
    fake.mergeShas.set("acme/core#101", "m101");
    fake.mergeShas.set("acme/core#102", "m102");
    fake.ancestors.set("acme/core:m101...me:main", "ancestor");
    fake.ancestors.set("acme/core:m102...me:main", "not-ancestor");
    // 103: no merge sha known
    await syncFork(db, fake, map.id, T(10));
    const ev = Object.fromEntries((await db.upstreamPrState.findMany()).map((p) => [p.number, p.evidence]));
    expect(ev).toEqual({ 101: "ANCESTRY_EXACT", 102: "NOT_DETECTED", 103: "UNKNOWN" });

    const ackUser = await db.user.create({ data: { githubId: 77n, login: "acker" } });
    const member = await db.member.create({ data: { workspaceId: wsId, userId: ackUser.id } });
    await db.upstreamPrState.update({ where: { mappingId_number: { mappingId: map.id, number: 102 } }, data: { ackedById: member.id } });
    await syncFork(db, fake, map.id, T(11));
    expect((await db.upstreamPrState.findUniqueOrThrow({ where: { mappingId_number: { mappingId: map.id, number: 102 } } })).evidence).toBe("MANUAL_ACK");
  });

  it("upstream issues enter triage once and decisions are never overwritten", async () => {
    const { map, up } = await setup();
    await db.workItem.create({ data: { repositoryId: up.id, githubId: 900n, number: 9, type: "ISSUE", title: "Upstream bug", htmlUrl: "u", createdAtGh: T(1), updatedAtGh: T(2) } });
    await syncFork(db, fake, map.id, T(10));
    await db.upstreamIssueTriage.update({ where: { mappingId_issueNumber: { mappingId: map.id, issueNumber: 9 } }, data: { status: "RELEVANT", note: "yes" } });
    await syncFork(db, fake, map.id, T(11));
    const t = await db.upstreamIssueTriage.findFirstOrThrow();
    expect(t).toMatchObject({ status: "RELEVANT", note: "yes" });
    expect(await db.upstreamIssueTriage.count()).toBe(1);
  });
});

describe("job queue", () => {
  it("coalesces duplicates by dedupe key and retries with backoff, honouring Retry-After", async () => {
    await enqueue(db, { type: "t", payload: {}, dedupeKey: "k1", runAt: T(1) });
    await enqueue(db, { type: "t", payload: {}, dedupeKey: "k1", runAt: T(1) });
    expect(await db.job.count()).toBe(1);
    const res = await runOne(db, { t: async () => { throw new GithubError("rate-limited", "slow down", 300); } }, T(2));
    expect(res).toBe("retry");
    const j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("QUEUED");
    expect(j.runAt).toEqual(new Date(T(2).getTime() + 300_000));
    expect(await runOne(db, { t: async () => {} }, T(2))).toBe("idle"); // not due yet
    expect(await runOne(db, { t: async () => {} }, new Date(T(2).getTime() + 301_000))).toBe("done");
  });

  it("permanent failures are not retried; exhausted attempts fail", async () => {
    await enqueue(db, { type: "t", payload: {}, runAt: T(1) });
    expect(await runOne(db, { t: async () => { throw new GithubError("not-found", "gone"); } }, T(2))).toBe("failed");
    await enqueue(db, { type: "u", payload: {}, runAt: T(1), maxAttempts: 1 });
    expect(await runOne(db, { u: async () => { throw new Error("boom"); } }, T(2))).toBe("failed");
  });

  it("two concurrent workers never run the same job twice", async () => {
    for (let i = 0; i < 6; i++) await enqueue(db, { type: "w", payload: { i }, runAt: T(1) });
    let ran = 0;
    const h = { w: async () => { ran++; await new Promise((r) => setTimeout(r, 5)); } };
    await Promise.all(Array.from({ length: 12 }, () => runOne(db, h, T(2))));
    expect(ran).toBe(6);
    expect(await db.job.count({ where: { status: "DONE" } })).toBe(6);
  });

  it("a later light request never downgrades a queued full run", async () => {
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: "r1", full: true }, dedupeKey: "sync:r1" });
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: "r1" }, dedupeKey: "sync:r1" });
    const job = await db.job.findUniqueOrThrow({ where: { dedupeKey: "sync:r1" } });
    expect(job.payload).toEqual({ repositoryId: "r1", full: true });
  });

  it("jobs left RUNNING by a dead worker are reclaimed", async () => {
    await db.job.create({ data: { type: "x", payload: {}, status: "RUNNING", lockedAt: T(1) } });
    expect(await reclaimStuck(db, 60_000, T(5))).toBe(1);
  });
});

describe("Octokit adapter (HTTP mocked)", () => {
  const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
    new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...init.headers } });
  const repoJson = { id: 42, full_name: "acme/thing", name: "thing", html_url: "https://github.com/acme/thing", private: false, visibility: "public", fork: false, default_branch: "trunk", archived: false, owner: { id: 7, login: "acme", type: "User", avatar_url: "a" } };

  it("imports a public repository with NO Authorization header and takes owner type from the API", async () => {
    const seen: Headers[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return json(repoJson); }) as typeof fetch;
    const port = new OctokitPort(createOctokit(undefined, f));
    const m = await port.getRepository("acme", "thing");
    expect(seen[0].get("authorization")).toBeNull();
    expect(m.owner.type).toBe("USER"); // a name that looks like an org is still a User if the API says so
    expect(m.defaultBranch).toBe("trunk");
  });

  it("maps a primary rate limit to a typed error with the reset time", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const f = (async () => json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60", "x-ratelimit-reset": String(reset) } })) as typeof fetch;
    const port = new OctokitPort(createOctokit(undefined, f));
    const e = await port.getRepository("a", "b").catch((x) => x);
    expect(e).toBeInstanceOf(GithubError);
    expect(e.kind).toBe("rate-limited");
    expect(e.resetAt?.getTime()).toBe(reset * 1000);
  });

  it("uses ETags so unchanged public data answers 304 from cache", async () => {
    const store = new Map<string, { etag: string | null; body: unknown }>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, etag: string | null, body: unknown) => void store.set(k, { etag, body }) };
    let n = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      n++;
      if (new Headers(init?.headers).get("if-none-match") === '"abc"') return new Response(null, { status: 304, headers: { "x-ratelimit-remaining": "59", "x-ratelimit-limit": "60", "x-ratelimit-reset": "9999999999" } });
      return json(repoJson, { headers: { etag: '"abc"' } });
    }) as typeof fetch;
    const port = new OctokitPort(createOctokit(undefined, f), { cache });
    await port.getRepository("acme", "thing");
    const again = await port.getRepository("acme", "thing");
    expect(n).toBe(2);
    expect(again.fullName).toBe("acme/thing");
  });

  it("a cached page answered 304 still knows there is a next page (GitHub sends no Link on a 304)", async () => {
    const store = new Map<string, { etag: string | null; body: unknown }>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, etag: string | null, body: unknown) => void store.set(k, { etag, body }) };
    const link = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=12>; rel="last"';
    const seen: (string | null)[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("if-none-match");
      seen.push(inm);
      if (inm === '"abc"') return new Response(null, { status: 304, headers: { etag: '"abc"' } });
      return json([], { headers: { etag: '"abc"', link } });
    }) as typeof fetch;
    const port = new OctokitPort(createOctokit("tok", f), { cache });
    expect((await port.listIssuesAndPulls("o", "r", { page: 1 })).nextPage).toBe(2);
    expect((await port.listIssuesAndPulls("o", "r", { page: 1 })).nextPage).toBe(2); // from the 304
    expect(seen).toEqual([null, '"abc"']);
  });

  it("a cache entry written before the Link header was kept is refetched in full, not trusted", async () => {
    const legacy = new Map<string, { etag: string | null; body: unknown }>();
    const cache = { get: async (k: string) => legacy.get(k) ?? (legacy.set(k, { etag: '"old"', body: [] }), legacy.get(k)!), set: async () => {} };
    const seen: (string | null)[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("if-none-match")); return json([], { headers: { etag: '"new"', link: '<https://api.github.com/x?page=3>; rel="next"' } }); }) as typeof fetch;
    const port = new OctokitPort(createOctokit("tok", f), { cache });
    expect((await port.listIssuesAndPulls("o", "r", { page: 2 })).nextPage).toBe(3);
    expect(seen).toEqual([null]);
  });

  it("coalesces identical concurrent public requests into one HTTP call", async () => {
    let n = 0;
    const f = (async () => { n++; await new Promise((r) => setTimeout(r, 10)); return json(repoJson); }) as typeof fetch;
    const port = new OctokitPort(createOctokit(undefined, f));
    await Promise.all([port.getRepository("acme", "thing"), port.getRepository("acme", "thing"), port.getRepository("acme", "thing")]);
    expect(n).toBe(1);
  });

  it("merge sends the confirmed head SHA so GitHub refuses if it moved", async () => {
    let body: Record<string, unknown> = {};
    const f = (async (_u: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ merged: true, message: "ok" }); }) as typeof fetch;
    const port = new OctokitPort(createOctokit("tok", f));
    await port.mergePull("o", "r", 5, { method: "squash", expectedHeadSha: "abc123" });
    expect(body).toMatchObject({ sha: "abc123", merge_method: "squash" });
  });

  it("an unreadable mergeable value stays UNKNOWN, never MERGEABLE", async () => {
    const f = (async () => json({ id: 1, number: 3, title: "t", state: "open", mergeable: null, head: { sha: "h", ref: "f" }, base: { ref: "main" }, user: { login: "u", id: 2 }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", html_url: "x", labels: [] })) as typeof fetch;
    const port = new OctokitPort(createOctokit("tok", f));
    expect((await port.getPull("o", "r", 3)).mergeable).toBe("UNKNOWN");
  });
});
