import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, type Db } from "@/lib/db";
import { GhTimeoutError, IdentityError, defaultGhRunner, liveGhProcesses, terminateAllGh } from "@/lib/github/exec";
import { GithubError } from "@/lib/github/port";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { authKeysToRecheck, cancelAllDiscovery, dueKeys, isRefreshing, readCached, recoverInterrupted, refreshInBackground, fromJson, toJson } from "@/lib/local/discovery";
import { useFakeGh } from "./fake-gh";

const files: string[] = [];
const dbs: Db[] = [];
const fresh = () => {
  const f = path.resolve(".data", `client-discovery-${process.pid}-${files.length}.db`);
  files.push(f);
  const db = createPrisma(f);
  dbs.push(db);
  return db;
};
afterEach(async () => {
  terminateAllGh();
  await Promise.all(dbs.splice(0).map((d) => d.$disconnect()));
  for (const f of files.splice(0)) for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
});

const T0 = new Date("2026-10-29T10:00:00Z");
let t = T0.getTime();
const now = () => new Date(t);
const noSleep = async () => {};
const opts = (extra: Record<string, unknown> = {}) => ({ now, sleep: noSleep, ...extra });
beforeEach(() => {
  t = T0.getTime();
});

describe("pages read the saved list, never the network", () => {
  it("an empty cache is reported as 'not checked yet', not as an empty account", async () => {
    const db = fresh();
    const v = await readCached(db, "repos");
    expect(v).toMatchObject({ state: "EMPTY", payload: null, fetchedAt: null, stale: true });
  });

  it("a successful refresh is saved with its time and survives BigInt ids", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ({ repos: [{ githubId: 9007199254740993n, fullName: "a/b" }], notes: [] }), opts());
    const v = await readCached<{ repos: { githubId: bigint }[] }>(db, "repos", now());
    expect(v.state).toBe("FRESH");
    expect(v.payload?.repos[0].githubId).toBe(9007199254740993n);
    expect(v.fetchedAt?.getTime()).toBe(T0.getTime());
    expect(v.stale).toBe(false);
    t += 6 * 60_000;
    expect((await readCached(db, "repos", now())).stale).toBe(true);
    expect(fromJson(toJson({ n: 5n }))).toEqual({ n: 5n });
  });
});

describe("failures keep the saved list and say why", () => {
  it("offline: bounded retries with backoff, then the OLD list stays, marked offline, with a retry time", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ["good"], opts());
    t += 10 * 60_000;
    const sleeps: number[] = [];
    let calls = 0;
    await refreshInBackground(db, "repos", async () => { calls++; throw new TypeError("fetch failed"); }, opts({ sleep: async (ms: number) => { sleeps.push(ms); } }));
    const v = await readCached<string[]>(db, "repos", now());
    expect(calls).toBe(3); // bounded
    expect(sleeps).toEqual([2000, 8000]); // backoff
    expect(v).toMatchObject({ state: "OFFLINE", payload: ["good"], attempts: 3 });
    expect(v.fetchedAt?.getTime()).toBe(T0.getTime()); // still the last SUCCESS
    expect(v.nextRetryAt!.getTime()).toBeGreaterThan(t);
    expect(v.error).toMatch(/could not be reached/i);
  });

  it("a stalled subprocess is cut off at the deadline and does not hang the refresh", async () => {
    const db = fresh();
    const t0 = Date.now();
    await refreshInBackground(db, "repos", (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), opts({ timeoutMs: 80, maxAttempts: 1 }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await readCached(db, "repos")).toMatchObject({ state: "OFFLINE", error: expect.stringMatching(/did not answer/i) });
  });

  it("a bug of ours (a TypeError that is not a failed fetch) is reported as an error, never as being offline", async () => {
    const db = fresh();
    let calls = 0;
    await refreshInBackground(db, "repos", async () => { calls++; return (undefined as unknown as string[]).map((x) => x); }, opts());
    expect(calls).toBe(1); // not retried as if the network were down
    expect(await readCached(db, "repos")).toMatchObject({ state: "ERROR", error: expect.stringMatching(/undefined|map/) });
  });

  it("rate limited: no retry, the saved list stays, and the reset time is shown", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ["good"], opts());
    const reset = new Date(t + 15 * 60_000);
    let calls = 0;
    await refreshInBackground(db, "repos", async () => { calls++; throw new GithubError("rate-limited", "limit", 900, reset, 403); }, opts());
    const v = await readCached<string[]>(db, "repos", now());
    expect(calls).toBe(1);
    expect(v).toMatchObject({ state: "RATE_LIMITED", payload: ["good"] });
    expect(v.nextRetryAt?.getTime()).toBe(reset.getTime());
  });

  it("sign-in needed: no retry, the saved list stays, and it is not reported as offline or empty", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ["good"], opts());
    await refreshInBackground(db, "repos", async () => { throw new IdentityError("not-signed-in", "alice is not signed in"); }, opts());
    expect(await readCached(db, "repos")).toMatchObject({ state: "AUTH", payload: ["good"], error: "alice is not signed in" });
    expect(await dueKeys(db, new Date(t + 24 * 3600_000))).not.toContain("repos"); // waits for the person, not a timer
  });

  it("a list stuck on sign-in-needed is offered for one re-check per minute, never on the retry timer", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ["good"], opts());
    await refreshInBackground(db, "repos", async () => { throw new IdentityError("not-signed-in", "alice is not signed in"); }, opts());
    expect(await authKeysToRecheck(db, new Date())).not.toContain("repos"); // just failed: not yet
    expect(await authKeysToRecheck(db, new Date(Date.now() + 61_000))).toContain("repos");
    expect(await dueKeys(db, new Date(Date.now() + 24 * 3600_000))).not.toContain("repos");
  });

  it("reconnect: the next refresh replaces the old list and clears the error", async () => {
    const db = fresh();
    await refreshInBackground(db, "repos", async () => ["old"], opts());
    await refreshInBackground(db, "repos", async () => { throw new TypeError("fetch failed"); }, opts({ maxAttempts: 1 }));
    expect((await readCached(db, "repos")).state).toBe("OFFLINE");
    t += 3 * 60_000;
    expect(await dueKeys(db, now())).toContain("repos"); // the scheduler would retry it now
    await refreshInBackground(db, "repos", async () => ["new"], opts());
    expect(await readCached(db, "repos", now())).toMatchObject({ state: "FRESH", payload: ["new"], error: null, attempts: 0 });
  });
});

describe("deduplication, shutdown and restart", () => {
  it("concurrent requests share one refresh", async () => {
    const db = fresh();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = async () => { calls++; await gate; return [1]; };
    const a = refreshInBackground(db, "k", load, opts());
    const b = refreshInBackground(db, "k", load, opts());
    expect(a).toBe(b);
    expect(isRefreshing(db, "k")).toBe(true);
    release();
    await a;
    expect(calls).toBe(1);
    expect(isRefreshing(db, "k")).toBe(false);
  });

  it("shutdown during discovery cancels the in-flight call and leaves an honest state", async () => {
    const db = fresh();
    let aborted = false;
    const p = refreshInBackground(db, "repos", (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })), opts({ timeoutMs: 30_000 }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await readCached(db, "repos")).state).toBe("RETRYING");
    cancelAllDiscovery(db);
    await p;
    expect(aborted).toBe(true);
    expect(isRefreshing(db, "repos")).toBe(false);
    expect(await readCached(db, "repos")).toMatchObject({ state: "OFFLINE", error: expect.stringMatching(/interrupted/i) });
  });

  it("an attempt a crash left 'retrying' is marked interrupted on the next start", async () => {
    const db = fresh();
    await db.discoveryCache.create({ data: { key: "repos", state: "RETRYING", attempts: 2, payload: toJson(["kept"]), fetchedAt: T0 } });
    expect(await recoverInterrupted(db, now())).toBe(1);
    expect(await readCached(db, "repos")).toMatchObject({ state: "OFFLINE", payload: ["kept"] });
  });

  it("two profiles never share a cache or a refresh", async () => {
    const a = fresh();
    const b = fresh();
    await refreshInBackground(a, "repos", async () => ["alice's"], opts());
    expect((await readCached(b, "repos")).payload).toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pa = refreshInBackground(a, "x", async () => { await gate; return 1; }, opts());
    expect(isRefreshing(b, "x")).toBe(false);
    release();
    await pa;
  });
});

describe("a real stalled gh process does not block reading the saved list", () => {
  it("the saved list is returned instantly while a refresh is stuck, then the process is killed at the deadline", async () => {
    const gh = useFakeGh({ active: "alice", accounts: { alice: { id: 1, token: "tok" } }, mode: "stall" });
    try {
      const db = fresh();
      await refreshInBackground(db, "repos", async () => ["saved"], opts());
      const pending = refreshInBackground(db, "repos", async (signal) => (await defaultGhRunner(["api", "user"], { signal, timeoutMs: 400 })).stdout, opts({ timeoutMs: 5000, maxAttempts: 1 }));
      // while the subprocess is hung, the page-side read is immediate
      const t0 = Date.now();
      const view = await readCached<string[]>(db, "repos", now());
      expect(Date.now() - t0).toBeLessThan(200);
      expect(view.payload).toEqual(["saved"]);
      await pending;
      expect(await readCached(db, "repos")).toMatchObject({ state: "OFFLINE", payload: ["saved"] });
      expect(liveGhProcesses()).toBe(0);
      expect(new GhTimeoutError(400).message).toMatch(/did not answer/);
    } finally {
      gh.cleanup();
    }
  });
});

describe("pending edits do not cross profiles or spaces", () => {
  it("an outbox row belongs to one profile database and one space", async () => {
    const a = fresh();
    const b = fresh();
    const ws = await a.workspace.create({ data: { name: "w" } });
    const sp = await a.space.create({ data: { remoteId: "s1", teamRemoteId: "t", kind: "COMMON", name: "S", repoOwner: "o", repoName: "r", access: "OK" } });
    await a.outboxOp.create({ data: { id: "op", spaceId: sp.id, entityType: "project", entityId: "p", kind: "UPSERT", data: { n: 1 }, baseVersion: 0 } });
    expect(await a.outboxOp.count()).toBe(1);
    expect(await b.outboxOp.count()).toBe(0);
    expect(ws.id).toBeTruthy();
  });
});

describe("how a dead transport reaches the page", () => {
  it("a fetch with no HTTP response through Octokit is a NETWORK error (so it is retried as offline), not a generic 500", async () => {
    const port = new OctokitPort(createOctokit(undefined, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch));
    await expect(port.listAuthorizedRepositories(1)).rejects.toMatchObject({ kind: "network" });
  });

  it("an identity block keeps its specific, actionable message instead of a generic 'credential invalid'", async () => {
    const blocked = (async () => new Response(JSON.stringify({ message: "alice is not signed in to the GitHub CLI. Run: gh auth login" }), { status: 401, headers: { "content-type": "application/json", "x-mergeport-identity": "not-signed-in" } })) as unknown as typeof fetch;
    await expect(new OctokitPort(createOctokit(undefined, blocked)).listAuthorizedRepositories(1)).rejects.toMatchObject({ kind: "auth", message: expect.stringMatching(/gh auth login/) });
  });
});
