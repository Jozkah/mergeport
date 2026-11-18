import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewer } from "@/lib/authz/viewer";
import { RELEASE_MAX_PER_CHECK, cleanSettings, pickNewReleases, plainExcerpt, safeReleaseUrl } from "@/lib/domain/upstream-update";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { FakeGithub } from "@/lib/github/fake";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { GithubError, type RemoteRelease } from "@/lib/github/port";
import { handlers } from "@/lib/local/handlers";
import { maybeRequestUpdate } from "@/lib/local/upstream-updater-job";
import { runUpdate } from "@/lib/local/upstream-updater";
import { buildDigest } from "@/lib/services/digest";
import { RELEASES_JOB, maybeRequestReleaseCheck, releasesJobKey, runReleaseCheck } from "@/lib/services/upstream-releases";
import { getUpdateConfig, listUpdateRuns, markReleasesSeen, requestUpdateRun, saveUpdateConfig, upstreamUpdateAttention } from "@/lib/services/upstream-update";
import { UpstreamUpdate } from "@/components/forks/UpstreamUpdate";
import { testDb } from "./helpers";
import { setupMapping } from "./updater-world";

// The release watch must never reach git or a verify command: both modules throw (and count) if anything imports a call of them.
const touched = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/local/git-write", () => ({
  createGitWriter: () => {
    touched.n++;
    throw new Error("git was touched");
  },
  assertInside: async () => {
    touched.n++;
    throw new Error("git was touched");
  },
  redactUrls: (s: string) => s,
}));
vi.mock("@/lib/local/verify-run", () => ({
  runVerify: async () => {
    touched.n++;
    throw new Error("verify was touched");
  },
}));

vi.setConfig({ testTimeout: 30_000 });
const db = testDb();

const T0 = new Date("2026-11-17T10:00:00Z");
const at = (minutes: number) => () => new Date(T0.getTime() + minutes * 60_000);
const rel = (n: number, o: Partial<RemoteRelease> = {}): RemoteRelease => ({ id: String(1000 + n), tag: `v${n}`, name: `Release ${n}`, htmlUrl: `https://github.com/upstream/proj/releases/tag/v${n}`, publishedAt: new Date(Date.UTC(2026, 10, 1, 0, n)), draft: false, prerelease: false, body: `Notes of ${n}`, ...o });

async function watch(o: { includePrereleases?: boolean; list?: RemoteRelease[] } = {}) {
  const s = await setupMapping(db, { mode: "releases", includePrereleases: o.includePrereleases });
  const gh = new FakeGithub();
  gh.setReleases("upstream", "proj", o.list ?? [rel(1), rel(2)]);
  const check = (minutes: number, manual = false) => runReleaseCheck(db, gh, s.mapping.id, { now: at(minutes), manual });
  const runs = () => db.upstreamUpdateRun.findMany({ where: { mappingId: s.mapping.id, state: "release-found" }, orderBy: { startedAt: "asc" } });
  const cfg = () => db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } });
  return { s, gh, check, runs, cfg };
}

async function member(workspaceId: string, login: string, grant?: { repositoryId: string; canManageWork: boolean }) {
  const user = await db.user.create({ data: { githubId: BigInt(Math.floor(Math.random() * 1e9) + 100), login } });
  const m = await db.member.create({ data: { workspaceId, userId: user.id, role: "MEMBER" } });
  if (grant) await db.repositoryGrant.create({ data: { memberId: m.id, repositoryId: grant.repositoryId, canManageWork: grant.canManageWork, grantedById: m.id } });
  return (await loadViewer(db, user.id))!;
}

beforeEach(() => {
  touched.n = 0;
});

describe("pure rules", () => {
  it("picks new releases: no drafts, prereleases only on request, oldest first, newest five kept", () => {
    const list = [rel(1), rel(2), rel(3, { prerelease: true }), rel(4, { draft: true, publishedAt: null }), rel(5)];
    const base = { after: new Date(Date.UTC(2026, 10, 1, 0, 1)), warned: new Set<string>() };
    expect(pickNewReleases(list, { ...base, includePrereleases: false }).fresh.map((r) => r.tag)).toEqual(["v2", "v5"]);
    expect(pickNewReleases(list, { ...base, includePrereleases: true }).fresh.map((r) => r.tag)).toEqual(["v2", "v3", "v5"]);
    expect(pickNewReleases(list, { ...base, includePrereleases: false, warned: new Set([rel(2).id]) }).fresh.map((r) => r.tag)).toEqual(["v5"]);
    const many = Array.from({ length: 9 }, (_, i) => rel(i + 1));
    const p = pickNewReleases(many, { after: null, warned: new Set(), includePrereleases: false });
    expect(p.fresh.map((r) => r.tag)).toEqual(["v5", "v6", "v7", "v8", "v9"]);
    expect(p).toMatchObject({ more: 4, newest: { tag: "v9" } });
    expect(RELEASE_MAX_PER_CHECK).toBe(5);
  });

  it("keeps notes as plain bounded text and links only into the upstream repository", () => {
    expect(plainExcerpt("a\r\n\r\n\r\n\r\nb\u0000\u0007c")).toBe("a\n\nbc");
    expect(plainExcerpt("x".repeat(700))).toHaveLength(601);
    expect(plainExcerpt(null)).toBe("");
    expect(safeReleaseUrl("https://github.com/Upstream/Proj/releases/tag/v1", "upstream/proj")).toBe("https://github.com/Upstream/Proj/releases/tag/v1");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://github.com/upstream/proj/x", "https://evil.example/upstream/proj/releases", "https://github.com/other/proj/releases/tag/v1", "https://github.com/upstream/proj", "https://u:p@github.com/upstream/proj/x", "not a url", ""]) expect(safeReleaseUrl(bad, "upstream/proj"), bad).toBeNull();
  });

  it("validates per mode: release mode needs no verify command and ignores merge settings; push still needs one in merge mode", () => {
    const map = { forkBranch: "main", upstreamBranch: "main" };
    expect(cleanSettings({ mode: "releases", enabled: "on", promote: "push", timeoutSec: "1", verifyCommand: 'a "b', branchName: "main" }, map)).toEqual({ mode: "releases", enabled: true, includePrereleases: null });
    expect(cleanSettings({ mode: "releases", includePrereleases: "on" }, map)).toMatchObject({ enabled: false, includePrereleases: true });
    expect(() => cleanSettings({ mode: "merge", promote: "push" }, map)).toThrow(/needs a verify command/);
    expect(() => cleanSettings({ promote: "push" }, map)).toThrow(/needs a verify command/);
    expect(cleanSettings({ enabled: "on", verifyCommand: "npm test" }, map)).toMatchObject({ mode: "merge", enabled: true, verifyCommand: "npm test", includePrereleases: null });
  });
});

describe("release watch", () => {
  it("the first check only records the newest release as the baseline: no warning, no notification", async () => {
    const w = await watch();
    expect(await w.check(0)).toEqual({ result: "baseline", warned: 0 });
    expect(await w.runs()).toEqual([]);
    expect(await db.notification.count()).toBe(0);
    expect(await w.cfg()).toMatchObject({ releasesBaselined: true, lastReleaseTag: "v2", releasesCheckedAt: at(0)() });
  });

  it("a release published after the baseline warns once, with a notification and a history row; asking again does not repeat it", async () => {
    const w = await watch();
    await w.check(0);
    w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3, { body: "Fixes\n\n\n\nthings" })]);
    expect(await w.check(20)).toEqual({ result: "checked", warned: 1 });
    const [run] = await w.runs();
    expect(run).toMatchObject({ state: "release-found", releaseId: rel(3).id, trigger: "auto", finishedAt: at(20)() });
    expect(run.release).toMatchObject({ tag: "v3", name: "Release 3", url: "https://github.com/upstream/proj/releases/tag/v3", notes: "Fixes\n\nthings", prerelease: false, inFork: null, more: 0 });
    const notes = await db.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "upstream-release", userId: w.s.user.id, repositoryId: w.s.fork.id, href: `/forks#m-${w.s.mapping.id}` });
    expect(notes[0].title).toBe("New upstream release v3: upstream/proj");
    // unchanged list: ETag answer, nothing created
    expect(await w.check(40)).toEqual({ result: "not-modified", warned: 0 });
    // changed ETag, same releases (an edit of the notes): still the same single warning
    w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3, { body: "edited" })]);
    expect(await w.check(60)).toEqual({ result: "checked", warned: 0 });
    expect(await w.runs()).toHaveLength(1);
    expect(await db.notification.count()).toBe(1);
    // a cursor that falls behind cannot make it warn again about v3: the release id is remembered by the history
    await db.upstreamUpdateConfig.update({ where: { mappingId: w.s.mapping.id }, data: { lastReleaseAt: rel(2).publishedAt, releasesEtag: null } });
    await w.check(80);
    expect(await w.runs()).toHaveLength(1);
  });

  it("ignores drafts always and prereleases unless the option is on", async () => {
    for (const include of [false, true]) {
      const w = await watch({ includePrereleases: include });
      await w.check(0);
      w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3, { prerelease: true }), rel(4, { draft: true, publishedAt: null }), rel(5, { draft: true, publishedAt: new Date(Date.UTC(2026, 10, 2)) })]);
      await w.check(20);
      expect((await w.runs()).map((r) => r.releaseId), `include=${include}`).toEqual(include ? [rel(3).id] : []);
      if (include) expect((await w.runs())[0].release).toMatchObject({ prerelease: true });
    }
  });

  it("changing which releases count (or switching the watch on) starts again from a baseline", async () => {
    const s = await setupMapping(db, null);
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "releases", enabled: "on" });
    expect(await db.job.count({ where: { type: RELEASES_JOB } })).toBe(1); // the baseline is asked for at once
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { releasesBaselined: true, lastReleaseTag: "v9", releasesEtag: '"x"', releasesCheckedAt: new Date() } });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "releases", enabled: "on" }); // nothing changed: the cursor stays
    expect(await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).toMatchObject({ releasesBaselined: true, lastReleaseTag: "v9" });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "releases", enabled: "on", includePrereleases: "on" });
    expect(await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).toMatchObject({ includePrereleases: true, releasesBaselined: false, lastReleaseTag: null, releasesEtag: null, releasesCheckedAt: null });
  });

  it("warns for at most five releases per check and says how many more there were", async () => {
    const w = await watch({ list: [rel(1)] });
    await w.check(0);
    w.gh.setReleases("upstream", "proj", Array.from({ length: 9 }, (_, i) => rel(i + 1)));
    expect(await w.check(20)).toEqual({ result: "checked", warned: 5 });
    const runs = await w.runs();
    expect(runs.map((r) => (r.release as { tag: string }).tag)).toEqual(["v5", "v6", "v7", "v8", "v9"]);
    expect(runs.map((r) => (r.release as { more: number }).more)).toEqual([0, 0, 0, 0, 3]);
    const titles = (await db.notification.findMany({ orderBy: { createdAt: "asc" } })).map((n) => n.title);
    expect(titles).toHaveLength(5);
    expect(titles.filter((t) => t.includes("(+3 more)"))).toEqual(["New upstream release v9: upstream/proj (+3 more)"]);
    w.gh.setReleases("upstream", "proj", [...Array.from({ length: 9 }, (_, i) => rel(i + 1)), rel(10)]);
    await w.check(40);
    expect(await w.runs()).toHaveLength(6); // the cursor moved past the ones beyond the cap: they are not announced later
  });

  it("says whether the fork already has the tag only when the API answers clearly", async () => {
    const w = await watch({ list: [rel(1)] });
    await w.check(0);
    w.gh.ancestors.set("upstream/proj:v2...owner:main", "ancestor");
    w.gh.ancestors.set("upstream/proj:v3...owner:main", "not-ancestor");
    w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3), rel(4)]);
    await w.check(20);
    expect((await w.runs()).map((r) => (r.release as { inFork: boolean | null }).inFork)).toEqual([true, false, null]);
  });

  it("an answer of 304 costs nothing and creates nothing (real ETag round trip through the port)", async () => {
    const server = new FakeGitHubServer();
    server.addUser("owner");
    server.addUser("upstream");
    expect((await server.fetchFor("upstream")("https://api.github.com/user/repos", { method: "POST", body: JSON.stringify({ name: "proj", private: false }) })).status).toBe(201);
    const wire = (n: number) => ({ id: 1000 + n, tag_name: `v${n}`, name: `Release ${n}`, html_url: `https://github.com/upstream/proj/releases/tag/v${n}`, published_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), draft: false, prerelease: false, body: `n${n}` });
    server.repo("upstream", "proj")!.releases = [wire(2), wire(1)];
    const seen: { etag: string | null; status: number }[] = [];
    const f = server.fetchFor("owner");
    const port = new OctokitPort(createOctokit(undefined, async (url: RequestInfo | URL, init?: RequestInit) => {
      const r = await f(url, init);
      if (String(url).includes("/releases")) seen.push({ etag: new Headers(init?.headers).get("if-none-match"), status: r.status });
      return r;
    }));
    const s = await setupMapping(db, { mode: "releases" });
    const check = (m: number) => runReleaseCheck(db, port, s.mapping.id, { now: at(m) });
    expect((await check(0)).result).toBe("baseline");
    expect((await check(20)).result).toBe("not-modified");
    expect(seen.map((x) => x.status)).toEqual([200, 304]);
    expect(seen[1].etag).toBe((await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).releasesEtag);
    expect(await db.upstreamUpdateRun.count({ where: { mappingId: s.mapping.id } })).toBe(0);
    server.repo("upstream", "proj")!.releases = [wire(3), wire(2), wire(1)];
    expect(await check(40)).toEqual({ result: "checked", warned: 1 });
    expect(seen.map((x) => x.status)).toEqual([200, 304, 200]);
  });

  it("a failed read is thrown for the job to retry, or shown in the history when the person asked", async () => {
    const w = await watch();
    w.gh.failNext(new GithubError("rate-limited", "slow down"));
    await expect(w.check(0)).rejects.toMatchObject({ kind: "rate-limited" });
    expect((await w.cfg()).releasesBaselined).toBe(false);
    w.gh.failNext(new GithubError("network", "offline"));
    expect(await w.check(1, true)).toEqual({ result: "failed", warned: 0 });
    expect((await listUpdateRuns(db, w.s.viewer, w.s.mapping.id))[0]).toMatchObject({ state: "failed", trigger: "manual", error: expect.stringContaining("offline") });
  });

  it("respects a notification preference that turned the kind off", async () => {
    const w = await watch();
    await db.notificationPref.create({ data: { userId: w.s.user.id, prefs: { kinds: { "upstream-update": { inApp: false } } } } });
    await w.check(0);
    w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3)]);
    await w.check(20);
    expect(await w.runs()).toHaveLength(1); // the history still has it
    expect(await db.notification.count()).toBe(0);
  });
});

describe("scheduling: one job per mapping, one check per ~15 minutes", () => {
  it("queues one deduplicated job, and not again within 14 minutes of the last check unless asked", async () => {
    const s = await setupMapping(db, { mode: "releases" });
    expect(await maybeRequestReleaseCheck(db, s.mapping.id, { now: T0 })).toBe(true);
    expect(await maybeRequestReleaseCheck(db, s.mapping.id, { now: T0 })).toBe(true);
    const jobs = await db.job.findMany({ where: { type: RELEASES_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupeKey: releasesJobKey(s.mapping.id), payload: { mappingId: s.mapping.id, manual: false } });
    await db.job.deleteMany();
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { releasesCheckedAt: T0 } });
    expect(await maybeRequestReleaseCheck(db, s.mapping.id, { now: at(10)() })).toBe(false);
    expect(await db.job.count()).toBe(0);
    expect(await maybeRequestReleaseCheck(db, s.mapping.id, { now: at(15)() })).toBe(true);
    await db.job.deleteMany();
    expect(await maybeRequestReleaseCheck(db, s.mapping.id, { now: at(1)(), manual: true })).toBe(true); // the person asked: no cap
  });

  it("the check itself enforces the cap too (a stale queued job does not spend a second request)", async () => {
    const w = await watch();
    await w.check(0);
    const before = w.gh.calls.length;
    expect(await w.check(5)).toEqual({ result: "skipped", warned: 0 });
    expect(w.gh.calls.length).toBe(before);
    expect((await w.check(5, true)).result).toBe("not-modified"); // a manual check is not capped
  });

  it("the regular reconcile cycle asks for release watches only: not merge mappings, not off, not checked a minute ago", async () => {
    const a = await setupMapping(db, { mode: "releases" });
    const run = () => handlers["reconcile.all"]({} as never, {} as never);
    await run();
    expect((await db.job.findMany({ where: { type: RELEASES_JOB } })).map((j) => j.dedupeKey)).toEqual([releasesJobKey(a.mapping.id)]);
    await db.job.deleteMany();
    await db.upstreamUpdateConfig.update({ where: { mappingId: a.mapping.id }, data: { releasesCheckedAt: new Date() } });
    await run();
    expect(await db.job.count({ where: { type: RELEASES_JOB } })).toBe(0);
    await db.upstreamUpdateConfig.update({ where: { mappingId: a.mapping.id }, data: { releasesCheckedAt: null, mode: "merge" } });
    await run();
    expect(await db.job.count({ where: { type: RELEASES_JOB } })).toBe(0);
    await db.upstreamUpdateConfig.update({ where: { mappingId: a.mapping.id }, data: { mode: "releases", enabled: false } });
    await run();
    expect(await db.job.count({ where: { type: RELEASES_JOB } })).toBe(0);
  });

  it("the job handler is registered", () => {
    expect(typeof handlers[RELEASES_JOB]).toBe("function");
  });
});

describe("modes do not leak into each other", () => {
  it("release mode never uses git or the verify command, and merge mode does not run release checks", async () => {
    const s = await setupMapping(db, { mode: "releases", verifyCommand: "node verify.js", promote: "push" });
    await db.forkComparison.create({ data: { mappingId: s.mapping.id, status: "fork-behind", aheadBy: 0, behindBy: 3, baseSha: "u1", headSha: "f1" } });
    expect(await maybeRequestUpdate(db, s.mapping.id)).toBe(false); // behind, enabled, but not a merge mapping
    const home = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "mpr-"));
    try {
      expect(await runUpdate({ db, home, port: async () => new FakeGithub(), remoteUrl: () => "unused" }, s.mapping.id)).toBeNull();
      expect(fs.existsSync(path.join(home, "updater"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    const gh = new FakeGithub();
    gh.setReleases("upstream", "proj", [rel(1)]);
    await runReleaseCheck(db, gh, s.mapping.id, { now: at(0) });
    gh.setReleases("upstream", "proj", [rel(1), rel(2)]);
    await runReleaseCheck(db, gh, s.mapping.id, { now: at(20) });
    expect(await db.upstreamUpdateRun.count({ where: { mappingId: s.mapping.id, state: "release-found" } })).toBe(1);
    expect(gh.writes).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(touched.n).toBe(0);
    expect(await db.job.count({ where: { type: "upstream.update" } })).toBe(0);

    const m = await setupMapping(db, { mode: "merge" });
    await runReleaseCheck(db, new FakeGithub(), m.mapping.id, { now: at(0), manual: true });
    expect(await maybeRequestReleaseCheck(db, m.mapping.id, { manual: true })).toBe(false);
    expect(await db.upstreamUpdateRun.count()).toBe(0);
    await db.forkComparison.create({ data: { mappingId: m.mapping.id, status: "fork-behind", aheadBy: 0, behindBy: 3, baseSha: "u1", headSha: "f1" } });
    expect(await maybeRequestUpdate(db, m.mapping.id)).toBe(true); // merge mode as before
  });

  it("switching mode keeps the stored verify command, promote mode, time limit and branch name", async () => {
    const s = await setupMapping(db, null);
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "merge", enabled: "on", verifyCommand: "node SECRET.js", promote: "push", timeoutSec: 300, branchName: "my/sync" });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "releases", enabled: "on", verifyCommand: "", promote: "push", timeoutSec: "nonsense", branchName: "main" }); // stale, even invalid, form values are not looked at
    const stored = await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } });
    expect(stored).toMatchObject({ mode: "releases", enabled: true, verifyCommand: "node SECRET.js", promote: "push", timeoutSec: 300, branchName: "my/sync", includePrereleases: false });
    expect(await getUpdateConfig(db, s.viewer, s.mapping.id)).toMatchObject({ mode: "releases", verifyCommand: "node SECRET.js" });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "merge", enabled: "on", verifyCommand: "node SECRET.js", promote: "push", timeoutSec: 300, branchName: "my/sync" });
    expect(await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).toMatchObject({ mode: "merge", verifyCommand: "node SECRET.js", promote: "push" });
    const audit = JSON.stringify(await db.auditLog.findMany());
    expect(audit).toContain('"mode":"releases"');
    expect(audit).not.toContain("SECRET");
  });

  it("validation follows the mode: release mode needs no command, merge mode with push still does", async () => {
    const s = await setupMapping(db, null);
    await expect(saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "merge", enabled: "on", promote: "push" })).rejects.toBeInstanceOf(ValidationError);
    expect(await db.upstreamUpdateConfig.count()).toBe(0);
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { mode: "releases", enabled: "on", promote: "push" });
    expect(await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).toMatchObject({ mode: "releases", verifyCommand: null, promote: "pr" });
  });

  it("Run now in release mode queues one release check, never an update run", async () => {
    const s = await setupMapping(db, { mode: "releases" });
    await requestUpdateRun(db, s.viewer, s.mapping.id);
    await requestUpdateRun(db, s.viewer, s.mapping.id);
    expect(await db.job.count({ where: { type: "upstream.update" } })).toBe(0);
    const jobs = await db.job.findMany({ where: { type: RELEASES_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ mappingId: s.mapping.id, manual: true });
  });

  it("who may do what is the same as for the merge settings", async () => {
    const s = await setupMapping(db, { mode: "releases" });
    const stranger = await member(s.workspace.id, "stranger");
    const reader = await member(s.workspace.id, "reader", { repositoryId: s.fork.id, canManageWork: false });
    await db.repositoryGrant.create({ data: { memberId: reader.memberId, repositoryId: s.upstream.id, grantedById: reader.memberId } });
    await expect(saveUpdateConfig(db, stranger, s.mapping.id, { mode: "releases", enabled: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveUpdateConfig(db, reader, s.mapping.id, { mode: "releases", enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestUpdateRun(db, stranger, s.mapping.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestUpdateRun(db, reader, s.mapping.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markReleasesSeen(db, stranger, s.mapping.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.job.count({ where: { type: RELEASES_JOB } })).toBe(0);
    await db.upstreamUpdateRun.create({ data: { mappingId: s.mapping.id, state: "release-found", releaseId: "1", release: { id: "1", tag: "v1" }, finishedAt: new Date(), triedShas: [], commits: [] } });
    expect(await markReleasesSeen(db, reader, s.mapping.id)).toBe(0); // only the administrator it is shown to marks it
    expect((await db.upstreamUpdateRun.findFirstOrThrow({ where: { mappingId: s.mapping.id } })).seenAt).toBeNull();
    expect(await markReleasesSeen(db, s.viewer, s.mapping.id)).toBe(1);
  });
});

describe("daily digest", () => {
  const NOW = new Date("2026-11-18T09:00:00Z");
  const keys = async (s: Awaited<ReturnType<typeof watch>>["s"]) => (await buildDigest(db, s.viewer, { now: NOW, tz: "UTC" })).attention.mine.entries.filter((e) => e.key.startsWith("upstream-release:"));

  it("an unseen release shows under what needs me and drops out once the Forks page was viewed", async () => {
    const w = await watch();
    await w.check(0);
    w.gh.setReleases("upstream", "proj", [rel(1), rel(2), rel(3)]);
    await w.check(600); // 2026-11-17 20:00
    const [e] = await keys(w.s);
    expect(e).toMatchObject({ reason: "New upstream release v3", repo: "owner/proj", href: "/forks", title: "upstream/proj for owner/proj" });
    expect(await upstreamUpdateAttention(db, w.s.viewer, { since: new Date("2026-11-11T00:00:00Z") })).toHaveLength(1);
    // a later merge run that went through does not answer a release warning
    await db.upstreamUpdateRun.create({ data: { mappingId: w.s.mapping.id, state: "up-to-date", startedAt: NOW, finishedAt: NOW, triedShas: [], commits: [] } });
    expect(await keys(w.s)).toHaveLength(1);
    await markReleasesSeen(db, w.s.viewer, w.s.mapping.id);
    expect(await keys(w.s)).toEqual([]);
    expect(await upstreamUpdateAttention(db, w.s.viewer, { since: new Date("2026-11-11T00:00:00Z") })).toEqual([]);
  });

  it("an unseen release also drops out after 14 days, and a hidden mapping contributes nothing", async () => {
    const w = await watch();
    await db.upstreamUpdateRun.createMany({
      data: [
        { mappingId: w.s.mapping.id, state: "release-found", releaseId: "old", release: { id: "old", tag: "v-old", more: 0 }, startedAt: new Date("2026-11-01T10:00:00Z"), finishedAt: new Date("2026-11-01T10:00:00Z"), triedShas: [], commits: [] },
        { mappingId: w.s.mapping.id, state: "release-found", releaseId: "new", release: { id: "new", tag: "v-new", more: 0 }, startedAt: new Date("2026-11-10T10:00:00Z"), finishedAt: new Date("2026-11-10T10:00:00Z"), triedShas: [], commits: [] },
      ],
    });
    expect((await keys(w.s)).map((x) => x.reason)).toEqual(["New upstream release v-new"]);
    const stranger = await member(w.s.workspace.id, "nobody");
    expect((await buildDigest(db, stranger, { now: NOW, tz: "UTC" })).attention.mine.entries.some((x) => x.key.startsWith("upstream-release:"))).toBe(false);
  });
});

describe("what the person sees", () => {
  const hostile = rel(3, { tag: "v3<script>alert(1)</script>", name: "<img src=x onerror=alert(1)>", body: "<script>alert('x')</script>\n[click](javascript:alert(1)) <b onmouseover=evil()>bold</b>", htmlUrl: "javascript:alert(1)" });

  it("renders release text as text, and links only into the upstream repository", async () => {
    const w = await watch({ list: [rel(1)] });
    await w.check(0);
    w.gh.setReleases("upstream", "proj", [rel(1), hostile, rel(4, { htmlUrl: "https://github.com/evil/other/releases/tag/v4" }), rel(5)]);
    await w.check(20);
    const html = renderToStaticMarkup(await UpstreamUpdate({ db, viewer: w.s.viewer, mappingId: w.s.mapping.id, forkBranch: "main", forkName: "owner/proj", upstreamName: "upstream/proj" }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<script|<img|<b onmouseover|href="javascript:/i);
    expect(html).toContain('href="https://github.com/upstream/proj/releases/tag/v5"');
    expect(html).not.toContain("evil/other");
    expect(html).toContain("New release");
    expect(html).toContain("Only warn about new upstream releases");
    expect(html).toContain("only reads the releases of");
  });

  it("a tampered stored row cannot smuggle in a link or markup either", async () => {
    const s = await setupMapping(db, { mode: "releases" });
    await db.upstreamUpdateRun.create({ data: { mappingId: s.mapping.id, state: "release-found", releaseId: "9", finishedAt: new Date(), triedShas: [], commits: [], release: { id: "9", tag: "v9", url: "javascript:alert(1)", notes: "<script>x</script>", inFork: "yes", more: "many", prerelease: 1 } } });
    const [r] = await listUpdateRuns(db, s.viewer, s.mapping.id);
    expect(r.release).toMatchObject({ tag: "v9", url: null, inFork: null, more: 0, prerelease: false });
    await db.upstreamUpdateRun.create({ data: { mappingId: s.mapping.id, state: "release-found", releaseId: "10", finishedAt: new Date(Date.now() + 1000), triedShas: [], commits: [], release: "garbage" } });
    expect((await listUpdateRuns(db, s.viewer, s.mapping.id))[0].release).toBeNull();
  });

  it("merge-mode pages say what they said before", async () => {
    const s = await setupMapping(db, { mode: "merge" });
    const html = renderToStaticMarkup(await UpstreamUpdate({ db, viewer: s.viewer, mappingId: s.mapping.id, forkBranch: "main", forkName: "owner/proj", upstreamName: "upstream/proj" }));
    expect(html).toContain("merges the newest upstream commit");
    expect(html).toContain("Run now");
    expect(html).not.toContain("Check now");
  });
});
