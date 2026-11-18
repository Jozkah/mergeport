import { beforeEach, describe, expect, it } from "vitest";
import { GithubError } from "@/lib/github/port";
import { Octokit } from "octokit";
import { OctokitPort } from "@/lib/github/octokit";
import { dbCache } from "@/lib/github/factory";
import { FORK_SYNC_REQUEST_CAP, syncFork } from "@/lib/sync/repository";
import { truncateAll } from "@/lib/demo/seed";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { testDb } from "./helpers";

/**
 * sync.fork against a simulated GitHub REST surface (the real OctokitPort over an in-test fetch, so every HTTP request is
 * counted): 500 merged upstream PRs, half of whose merge commits are in the fork.
 */
const db = testDb();
const T = (d: number) => new Date(Date.UTC(2026, 9, d));
const N = 500;
const meta = (id: bigint, owner: string, name: string, extra: Partial<RepoMeta> = {}): RepoMeta => ({
  githubId: id, fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: id + 1000n, login: owner, type: "ORGANIZATION" }, ...extra,
});

type Sim = { requests: string[]; inFork: (sha: string) => boolean; limitAfter: number | null };
let sim: Sim;
let port: OctokitPort;
let mapId: string;
let forkId: string;

function simFetch(s: Sim): typeof fetch {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const res = (status: number, body: unknown, etag?: string, remaining = "4000") =>
    new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": remaining, "x-ratelimit-reset": reset, ...(etag ? { etag } : {}) } });
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    s.requests.push(url.pathname + url.search);
    if (s.limitAfter !== null && s.requests.length > s.limitAfter) return res(403, { message: "API rate limit exceeded" }, undefined, "0");
    const answer = (body: unknown) => {
      const etag = `"${JSON.stringify(body).length}-${JSON.stringify(body).slice(0, 40)}"`;
      return new Headers(init.headers).get("if-none-match") === etag ? res(304, null, etag) : res(200, body, etag);
    };
    const path = decodeURIComponent(url.pathname);
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/acme\/core\/compare\/(.+)\.\.\.(.+)$/.exec(path))) {
      if (m[1] === "main") return answer({ status: "diverged", ahead_by: 1, behind_by: 250, total_commits: 1, base_commit: { sha: "up-tip" } });
      return answer({ status: s.inFork(m[1]) ? "ahead" : "diverged", ahead_by: 1, behind_by: 0, total_commits: 1 });
    }
    if ((m = /^\/repos\/acme\/core\/pulls\/(\d+)$/.exec(path))) return answer({ number: Number(m[1]), merge_commit_sha: `m${m[1]}` });
    if (/^\/repos\/acme\/core\/issues$/.test(path)) return answer([]);
    return res(404, { message: "Not Found" });
  }) as typeof fetch;
}

beforeEach(async () => {
  await truncateAll(db);
  const ws = await db.workspace.create({ data: { name: "ws" } });
  const up = await upsertRepository(db, ws.id, meta(10n, "acme", "core"));
  const fk = await upsertRepository(db, ws.id, meta(11n, "me", "core", { isFork: true, parentGithubId: 10n }));
  forkId = fk.id;
  await db.branch.create({ data: { repositoryId: up.id, name: "main", sha: "up-tip", isDefault: true } });
  await db.branch.create({ data: { repositoryId: fk.id, name: "main", sha: "fork-tip-1", isDefault: true } });
  mapId = (await db.forkMapping.create({ data: { forkRepoId: fk.id, upstreamRepoId: up.id, forkBranch: "main", upstreamBranch: "main" } })).id;
  await db.workItem.createMany({
    data: Array.from({ length: N }, (_, k) => ({ repositoryId: up.id, githubId: BigInt(k + 1), number: k + 1, type: "PULL_REQUEST" as const, title: `PR ${k + 1}`, state: "MERGED" as const, htmlUrl: "u", createdAtGh: T(1), updatedAtGh: T(2), mergedAtGh: new Date(T(1).getTime() + (k + 1) * 60_000) })),
  });
  sim = { requests: [], inFork: (sha) => Number(sha.slice(1)) % 2 === 0, limitAfter: null };
  // createOctokit's settings minus the throttling plugin's request spacing, which only slows hundreds of simulated calls down.
  port = new OctokitPort(new Octokit({ auth: "tok", throttle: { enabled: false, onRateLimit: () => false, onSecondaryRateLimit: () => false }, retry: { enabled: false }, request: { fetch: simFetch(sim) } }), { cache: dbCache(db) });
});

const evidence = async () => Object.fromEntries((await db.upstreamPrState.findMany({ where: { mappingId: mapId } })).map((s) => [s.number, s.evidence]));
const counts = async () => Object.fromEntries((await db.upstreamPrState.groupBy({ by: ["evidence"], where: { mappingId: mapId }, _count: true })).map((g) => [g.evidence, g._count]));
async function drain() {
  let runs = 0;
  for (; runs < 40 && (await db.upstreamPrState.count({ where: { mappingId: mapId, evidence: "UNKNOWN" } })) + N - (await db.upstreamPrState.count({ where: { mappingId: mapId } })) > 0; runs++) await syncFork(db, port, mapId, T(10));
  return runs;
}

describe("fork sync request budget", { timeout: 60_000 }, () => {
  it("stays under the cap, newest merged PRs first, carries the rest, then costs at most 3 requests when nothing changed", async () => {
    await syncFork(db, port, mapId, T(10));
    expect(sim.requests.length).toBe(59); // 1 comparison + 29 PRs x (merge SHA + ancestry)
    expect(sim.requests.length).toBeLessThanOrEqual(FORK_SYNC_REQUEST_CAP);
    const first = Object.keys(await evidence()).map(Number);
    expect(Math.min(...first)).toBeGreaterThan(N - FORK_SYNC_REQUEST_CAP); // the newest merges were examined first
    expect(Object.values(await evidence())).not.toContain("UNKNOWN");

    const runs = await drain();
    expect(runs).toBeGreaterThan(0);
    expect(await counts()).toEqual({ ANCESTRY_EXACT: N / 2, NOT_DETECTED: N / 2 });

    sim.requests.length = 0;
    await syncFork(db, port, mapId, T(11));
    expect(sim.requests.length).toBeLessThanOrEqual(3);
    expect(sim.requests).toEqual(["/repos/acme/core/compare/main...me%3Amain?per_page=1"]); // only the comparison (tips come from stored branches)
  });

  it("a fork tip move rechecks only NOT_DETECTED rows, reusing their stored merge commit", async () => {
    await drain();
    await db.branch.updateMany({ where: { repositoryId: forkId }, data: { sha: "fork-tip-2" } });
    sim.inFork = () => true; // the fork merged upstream
    sim.requests.length = 0;
    await syncFork(db, port, mapId, T(12));
    expect(sim.requests.length).toBeLessThanOrEqual(FORK_SYNC_REQUEST_CAP);
    expect(sim.requests.filter((r) => r.includes("/pulls/"))).toEqual([]); // merge SHAs are already known
    await drain();
    for (let k = 0; k < 10 && (await counts()).NOT_DETECTED; k++) await syncFork(db, port, mapId, T(12));
    expect(await counts()).toEqual({ ANCESTRY_EXACT: N });
  });

  it("a rate limit mid-loop stops the loop, keeps prior evidence and is reported", async () => {
    await drain();
    const before = await evidence();
    await db.branch.updateMany({ where: { repositoryId: forkId }, data: { sha: "fork-tip-2" } }); // NOT_DETECTED rows are due again
    sim.requests.length = 0;
    sim.limitAfter = 5;
    const e = await syncFork(db, port, mapId, T(13)).catch((x) => x);
    expect(e).toBeInstanceOf(GithubError);
    expect(e.kind).toBe("rate-limited");
    expect(sim.requests.length).toBe(6); // stopped at the first refusal instead of running through every PR
    expect(await evidence()).toEqual(before);
  });

  it("a rate-limited first pass records nothing as UNKNOWN for PRs it never reached", async () => {
    sim.limitAfter = 3;
    const e = await syncFork(db, port, mapId, T(10)).catch((x) => x);
    expect(e.kind).toBe("rate-limited");
    expect(await db.upstreamPrState.count({ where: { mappingId: mapId } })).toBeLessThanOrEqual(1);
  });

  it("`since` lists write no ETag cache rows; the unbounded list still does", async () => {
    await port.listIssuesAndPulls("acme", "core", { page: 1, since: T(3) });
    await port.listIssuesAndPulls("acme", "core", { page: 1, since: T(4) });
    expect(await db.publicCacheEntry.count({ where: { key: { contains: "/issues" } } })).toBe(0);
    await port.listIssuesAndPulls("acme", "core", { page: 1 });
    expect(await db.publicCacheEntry.count({ where: { key: { contains: "/issues" } } })).toBe(1);
  });

  it("compares a branch with a slash without double-encoding it", async () => {
    await port.compare({ owner: "acme", repo: "core", branch: "main" }, { owner: "me", branch: "feat/x" });
    const path = sim.requests.at(-1)!;
    expect(path).not.toContain("%25");
    expect(decodeURIComponent(path.split("?")[0])).toBe("/repos/acme/core/compare/main...me:feat/x");
  });
});
