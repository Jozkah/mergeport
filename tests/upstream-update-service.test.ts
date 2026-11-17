import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewer } from "@/lib/authz/viewer";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { GithubError } from "@/lib/github/port";
import { UpdateQueue, maybeRequestUpdate, UPDATE_JOB, updateJobKey, recoverUpdateRuns, updateHandlers } from "@/lib/local/upstream-updater-job";
import { exportBackup, parseBackup, restoreBackup } from "@/lib/services/backup";
import { getUpdateConfig, listUpdateRuns, requestUpdateRun, saveUpdateConfig, upstreamUpdateAttention } from "@/lib/services/upstream-update";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { testDb } from "./helpers";
import { setupMapping } from "./updater-world";

vi.setConfig({ testTimeout: 30_000 });
const db = testDb();

async function member(workspaceId: string, login: string, grant?: { repositoryId: string; canManageWork: boolean }) {
  const user = await db.user.create({ data: { githubId: BigInt(Math.floor(Math.random() * 1e9) + 100), login } });
  const m = await db.member.create({ data: { workspaceId, userId: user.id, role: "MEMBER" } });
  if (grant) await db.repositoryGrant.create({ data: { memberId: m.id, repositoryId: grant.repositoryId, canManageWork: grant.canManageWork, grantedById: m.id } });
  return (await loadViewer(db, user.id))!;
}

describe("settings: who may change them, and what is stored where", () => {
  it("only an administrator can change auto-update; a hidden mapping is not found; a viewer without manageWork cannot even request a run", async () => {
    const s = await setupMapping(db, null);
    const stranger = await member(s.workspace.id, "stranger"); // sees nothing
    const reader = await member(s.workspace.id, "reader", { repositoryId: s.fork.id, canManageWork: false });
    const upGrant = await db.repositoryGrant.create({ data: { memberId: reader.memberId, repositoryId: s.upstream.id, grantedById: reader.memberId } });
    expect(upGrant.id).toBeTruthy();
    await expect(saveUpdateConfig(db, stranger, s.mapping.id, { enabled: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getUpdateConfig(db, stranger, s.mapping.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveUpdateConfig(db, reader, s.mapping.id, { enabled: true, verifyCommand: "node evil.js" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.upstreamUpdateConfig.count()).toBe(0);
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true, verifyCommand: "node verify.js" });
    await expect(requestUpdateRun(db, reader, s.mapping.id)).rejects.toBeInstanceOf(ForbiddenError); // grant has no manageWork
    await expect(requestUpdateRun(db, stranger, s.mapping.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.job.count({ where: { type: UPDATE_JOB } })).toBe(0);
  });

  it("validates (push needs a verify command, bounded time, a distinct sync branch) and keeps the command out of the audit log", async () => {
    const s = await setupMapping(db, null);
    await expect(saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true, promote: "push" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true, timeoutSec: 99999 })).rejects.toThrow(/time limit/);
    await expect(saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true, branchName: "main" })).rejects.toThrow(/different branch/);
    await expect(saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true, verifyCommand: 'node "x' })).rejects.toThrow(/quote/);
    expect(await db.upstreamUpdateConfig.count()).toBe(0);
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: "on", verifyCommand: "node SECRET-VERIFY.js", promote: "push", timeoutSec: 300 });
    const stored = await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } });
    expect(stored).toMatchObject({ enabled: true, verifyCommand: "node SECRET-VERIFY.js", promote: "push", timeoutSec: 300, branchName: "mergeport/upstream-sync" });
    const audit = JSON.stringify(await db.auditLog.findMany());
    expect(audit).toContain("upstream.update-config");
    expect(audit).not.toContain("SECRET-VERIFY");
  });

  it("the stored command is shown to an administrator and never to anyone else", async () => {
    const s = await setupMapping(db, { verifyCommand: "node verify.js" });
    const reader = await member(s.workspace.id, "reader2", { repositoryId: s.fork.id, canManageWork: false });
    await db.repositoryGrant.create({ data: { memberId: reader.memberId, repositoryId: s.upstream.id, grantedById: reader.memberId } });
    expect((await getUpdateConfig(db, s.viewer, s.mapping.id)).verifyCommand).toBe("node verify.js");
    expect((await getUpdateConfig(db, reader, s.mapping.id)).verifyCommand).toBe("");
  });

  it("Run now needs auto-update to be on, and queues exactly one job per mapping", async () => {
    const s = await setupMapping(db, { enabled: false });
    await expect(requestUpdateRun(db, s.viewer, s.mapping.id)).rejects.toThrow(/Turn on auto-update/);
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { enabled: true } });
    await requestUpdateRun(db, s.viewer, s.mapping.id);
    await requestUpdateRun(db, s.viewer, s.mapping.id);
    const jobs = await db.job.findMany({ where: { type: UPDATE_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupeKey: updateJobKey(s.mapping.id), payload: { mappingId: s.mapping.id, manual: true } });
  });

  it("a mapping synced from a teammate arrives with auto-update OFF and no command (settings are local only)", async () => {
    const s = await setupMapping(db, null);
    expect(await db.upstreamUpdateConfig.count({ where: { mappingId: s.mapping.id } })).toBe(0);
    expect((await getUpdateConfig(db, s.viewer, s.mapping.id)).enabled).toBe(false);
  });
});

describe("backup restore never carries the verify command", () => {
  it("neither exports it nor imports it from a crafted backup, and leaves an existing command alone", async () => {
    const s = await setupMapping(db, { verifyCommand: "node LOCAL-ONLY.js" });
    const text = await exportBackup(db, s.viewer);
    expect(text).not.toContain("LOCAL-ONLY");
    expect(text).not.toContain("UpstreamUpdateConfig");
    expect(text).not.toContain("verifyCommand");

    // a hostile file: names the table, and smuggles the column onto the mapping rows
    const b = parseBackup(text);
    b.tables.UpstreamUpdateConfig = [{ id: "evil", mappingId: s.mapping.id, enabled: true, verifyCommand: "node EVIL.js", promote: "push", timeoutSec: 60, branchName: "x" }];
    b.tables.UpstreamUpdateRun = [{ id: "evilrun", mappingId: s.mapping.id, state: "promoted", triedShas: [], commits: [] }];
    b.tables.ForkMapping = b.tables.ForkMapping.map((r) => ({ ...r, verifyCommand: "node EVIL.js", enabled: true }));
    await restoreBackup(db, s.viewer, b, { confirmed: true });
    const cfg = await db.upstreamUpdateConfig.findMany();
    expect(cfg).toHaveLength(1);
    expect(cfg[0].verifyCommand).toBe("node LOCAL-ONLY.js");
    expect(cfg[0].promote).toBe("pr");
    expect(await db.upstreamUpdateRun.count()).toBe(0);

    // restoring onto a profile with no settings creates none
    await db.upstreamUpdateConfig.deleteMany();
    await restoreBackup(db, s.viewer, b, { confirmed: true });
    expect(await db.upstreamUpdateConfig.count()).toBe(0);
  });
});

describe("attention list for the digest", () => {
  const finished = (mappingId: string, state: string, at: string, extra: Record<string, unknown> = {}) => db.upstreamUpdateRun.create({ data: { mappingId, state, startedAt: new Date(at), finishedAt: new Date(at), triedShas: [], commits: [], ...extra } });
  it("returns the latest settled run of a mapping only when it needs the person and is recent enough", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    const since = new Date("2026-11-10T00:00:00Z");
    expect(await upstreamUpdateAttention(db, s.viewer, { since })).toEqual([]);
    await finished(s.mapping.id, "conflict", "2026-11-11T10:00:00Z", { filesConflicted: ["a.txt"] });
    const list = await upstreamUpdateAttention(db, s.viewer, { since });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: "conflict", files: ["a.txt"], fork: "owner/proj", upstream: "upstream/proj", mappingId: s.mapping.id });
    // a later run that went through replaces the old problem
    await finished(s.mapping.id, "promoted", "2026-11-12T10:00:00Z");
    expect(await upstreamUpdateAttention(db, s.viewer, { since })).toEqual([]);
    // an open pull request waits for review; so do failures and failed verification
    for (const [i, state] of (["pr-opened", "merged-untested", "verify-failed", "failed"] as const).entries()) {
      await finished(s.mapping.id, state, `2026-11-13T1${i}:00:00Z`, { prUrl: "https://x/pull/1" });
      expect((await upstreamUpdateAttention(db, s.viewer, { since })).map((r) => r.state)).toEqual([state]);
    }
    // up-to-date, cancelled and a still-running run need nobody; and a run before `since` is not news
    await finished(s.mapping.id, "up-to-date", "2026-11-14T10:00:00Z");
    expect(await upstreamUpdateAttention(db, s.viewer, { since })).toEqual([]);
    await finished(s.mapping.id, "failed", "2026-11-15T10:00:00Z");
    expect(await upstreamUpdateAttention(db, s.viewer, { since: new Date("2026-11-16T00:00:00Z") })).toEqual([]);
    expect(await upstreamUpdateAttention(db, s.viewer, { since })).toHaveLength(1);
  });

  it("does not show a mapping the viewer cannot see", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    await finished(s.mapping.id, "conflict", "2026-11-11T10:00:00Z");
    const stranger = await member(s.workspace.id, "nobody");
    expect(await upstreamUpdateAttention(db, stranger, { since: new Date("2026-11-01T00:00:00Z") })).toEqual([]);
    expect((await listUpdateRuns(db, s.viewer, s.mapping.id)).map((r) => r.state)).toEqual(["conflict"]);
    await expect(listUpdateRuns(db, stranger, s.mapping.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("one run at a time, one job per mapping", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("the queue runs mappings one after another, never two at once, and drops duplicates", async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const q = new UpdateQueue(async (id) => {
      running++;
      most = Math.max(most, running);
      order.push(id);
      await new Promise((r) => setTimeout(r, 25));
      running--;
    });
    expect(q.request("a", false)).toBe("started");
    expect(q.request("a", false)).toBe("duplicate");
    expect(q.request("b", false)).toBe("queued");
    expect(q.request("b", true)).toBe("duplicate");
    expect(q.request("c", false)).toBe("queued");
    await q.whenIdle();
    expect(order).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
    expect(q.waiting).toEqual([]);
    expect(q.request("a", false)).toBe("started"); // free again
    await q.whenIdle();
  });

  it("a run that throws does not wedge the queue", async () => {
    const seen: string[] = [];
    const q = new UpdateQueue(async (id) => {
      seen.push(id);
      if (id === "a") throw new Error("boom");
    });
    q.request("a", false);
    q.request("b", false);
    await q.whenIdle();
    expect(seen).toEqual(["a", "b"]);
  });

  it("after a comparison, a behind fork with auto-update on queues ONE deduplicated job", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    await db.forkComparison.create({ data: { mappingId: s.mapping.id, status: "fork-behind", aheadBy: 0, behindBy: 3, baseSha: "u1", headSha: "f1" } });
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(true);
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(true);
    expect(await db.job.count({ where: { type: UPDATE_JOB } })).toBe(1);
  });

  it("asks for nothing when auto-update is off, the fork is not behind, or nothing changed since a settled run", async () => {
    const s = await setupMapping(db, { verifyCommand: null, enabled: false });
    const behind = { mappingId: s.mapping.id, status: "diverged", aheadBy: 2, behindBy: 3, baseSha: "u1", headSha: "f1" };
    await db.forkComparison.create({ data: behind });
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(false); // off
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { enabled: true } });
    await db.forkComparison.create({ data: { ...behind, status: "identical", behindBy: 0, comparedAt: new Date(Date.now() + 1000) } });
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(false); // not behind
    await db.forkComparison.create({ data: { ...behind, comparedAt: new Date(Date.now() + 2000) } });
    const run = (state: string, up: string, fork: string) => db.upstreamUpdateRun.create({ data: { mappingId: s.mapping.id, state, upstreamSha: up, forkSha: fork, startedAt: new Date(), finishedAt: new Date(), triedShas: [], commits: [] } });
    await run("conflict", "u1", "f1");
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(false); // same shas as a settled conflict: not rebuilt every cycle
    expect(await db.job.count({ where: { type: UPDATE_JOB } })).toBe(0);
    await run("failed", "u1", "f1");
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(true); // a failed run is retried
    await db.job.deleteMany();
    await run("pr-opened", "u0", "f1");
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(true); // upstream moved on: update the pull request
  });

  it("registers the job handler, and a run left `running` by a closed app is marked cancelled", async () => {
    expect(Object.keys(updateHandlers(db))).toEqual([UPDATE_JOB]);
    const s = await setupMapping(db, { verifyCommand: null });
    const stale = await db.upstreamUpdateRun.create({ data: { mappingId: s.mapping.id, triedShas: [], commits: [] } });
    const busy = new UpdateQueue(async () => new Promise<void>(() => {}));
    busy.request(s.mapping.id, false);
    expect(await recoverUpdateRuns(db, busy)).toBe(0); // this process is running it
    expect(await recoverUpdateRuns(db, new UpdateQueue(async () => {}))).toBe(1);
    expect(await db.upstreamUpdateRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ state: "cancelled", error: expect.stringMatching(/closed/) });
  });
});

describe("pull request through the GitHub port", () => {
  async function world() {
    const server = new FakeGitHubServer();
    server.addUser("owner");
    server.addUser("stranger");
    const res = await server.fetchFor("owner")("https://api.github.com/user/repos", { method: "POST", body: JSON.stringify({ name: "proj", private: false }) });
    expect(res.status).toBe(201);
    const repo = server.repo("owner", "proj")!;
    repo.refs.set("heads/main", "a".repeat(40));
    repo.refs.set("heads/mergeport/upstream-sync", "b".repeat(40));
    return { server, port: (login: string) => new OctokitPort(createOctokit(undefined, server.fetchFor(login))) };
  }
  const input = { head: "mergeport/upstream-sync", base: "main", title: "Merge up@abc", body: "body one" };

  it("creates the pull request once and updates it afterwards", async () => {
    const { server, port } = await world();
    const first = await port("owner").openOrUpdatePull("owner", "proj", input);
    expect(first).toEqual({ number: 1, htmlUrl: "https://github.com/owner/proj/pull/1", created: true });
    const second = await port("owner").openOrUpdatePull("owner", "proj", { ...input, title: "Merge up@def", body: "body two" });
    expect(second).toEqual({ number: 1, htmlUrl: "https://github.com/owner/proj/pull/1", created: false });
    const prs = [...server.repo("owner", "proj")!.pulls!.values()];
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ title: "Merge up@def", body: "body two", head: "mergeport/upstream-sync", base: "main", state: "open" });
  });

  it("only ever lists, creates and edits: it never merges, closes or deletes", async () => {
    const { server, port } = await world();
    await port("owner").openOrUpdatePull("owner", "proj", input);
    await port("owner").openOrUpdatePull("owner", "proj", input);
    const verbs = server.calls.map((c) => c.replace(/^\S+ /, "").split(" ")[0]);
    expect(new Set(verbs)).toEqual(new Set(["GET", "POST", "PATCH"]));
    expect(server.calls.some((c) => /\/merge|\/git\/refs|DELETE/.test(c))).toBe(false);
  });

  it("maps a refusal to a typed error (no access, missing branch)", async () => {
    const { port } = await world();
    await expect(port("stranger").openOrUpdatePull("owner", "proj", input)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(port("owner").openOrUpdatePull("owner", "proj", { ...input, head: "nope" })).rejects.toBeInstanceOf(GithubError);
  });
});
