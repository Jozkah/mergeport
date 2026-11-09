import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { truncateAll } from "@/lib/demo/seed";
import { resetEnvCache } from "@/lib/env";
import { GitHubRest } from "@/lib/github/rest";
import { ensureLocalProfile } from "@/lib/local/profile";
import { MAX_BACKOFF_MS, MAX_IN_FLIGHT, MIN_REFRESH_GAP_MS, coveredIds, createRepoWatcher, watchTargets, watchView } from "@/lib/local/repo-watch";
import { WATCH_MAX_REPOS, effectiveWatchSeconds, watchLabel, watchTitle } from "@/lib/local/watch-format";
import { parseWatchMaxRepos, parseWatchSeconds, readWatchSettings, saveWatchSettings } from "@/lib/local/watch-settings";
import { saveHubCoverage } from "@/lib/hub/github-app-install";
import { ValidationError } from "@/lib/errors";
import { testDb } from "./helpers";

const h = vi.hoisted(() => ({ viewer: null as unknown, user: null as unknown }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ push: () => {}, refresh: () => {} }), redirect: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/auth/current", () => ({
  requireViewer: async () => {
    if (!h.viewer) throw new Error("Not signed in");
    return { viewer: h.viewer, user: h.user };
  },
}));
vi.mock("@/lib/authz-page", () => ({ requireViewer: async () => ({ viewer: h.viewer, user: h.user }) }));
vi.mock("@/lib/local/identity", () => ({ currentGhStatus: async () => ({ state: "missing-gh" }), checkProfile: async () => ({ kind: "no-profile" }) }));

const db = testDb();
const HUB = "hub-0123456789abcdef";

/** A fake GitHub REST with ETag semantics: GET with a matching if-none-match answers 304. */
function fakeGithub() {
  const etags = new Map<string, string>(); // `${repo}|issues` -> etag
  const failures = new Map<string, () => Response>();
  const calls: { repo: string; kind: string; sent: string | null }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    try {
      const m = /\/repos\/([^/]+\/[^/?]+)\/(issues|commits)\?/.exec(url)!;
      const repo = m[1];
      const kind = m[2];
      const sent = new Headers(init.headers).get("if-none-match");
      calls.push({ repo, kind, sent });
      const fail = failures.get(repo);
      if (fail) return fail();
      const tag = etags.get(`${repo}|${kind}`) ?? `"${kind}-0"`;
      if (sent === tag) return new Response(null, { status: 304 });
      return new Response("[]", { status: 200, headers: { etag: tag } });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return {
    rest: new GitHubRest(fetchImpl),
    calls,
    fail: (repo: string, r: (() => Response) | null) => (r ? failures.set(repo, r) : failures.delete(repo)),
    bump: (repo: string, kind: "issues" | "commits") => etags.set(`${repo}|${kind}`, `"${kind}-${Math.random()}"`),
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

let ws = "";
let owner = "";
let gid = 1000n;
async function addRepo(fullName: string, o: { demo?: boolean; status?: "ACTIVE" | "DISCONNECTED"; synced?: Date | null; githubId?: bigint } = {}) {
  return db.repository.create({
    data: {
      workspaceId: ws, githubId: o.githubId ?? gid++, ownerId: owner, name: fullName.split("/")[1], fullName, htmlUrl: `https://github.com/${fullName}`,
      isDemo: o.demo ?? false, trackingStatus: o.status ?? "ACTIVE", lastSyncedAt: o.synced === undefined ? null : o.synced,
    },
  });
}

type Over = Parameters<typeof createRepoWatcher>[0];
function setup(over: Partial<Over> = {}) {
  const gh = fakeGithub();
  const clock = { t: 1_000_000 };
  const refreshed: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const w = createRepoWatcher({
    db,
    now: () => clock.t,
    random: () => 0.5,
    isActive: () => true,
    rest: async () => gh.rest,
    refresh: async (id) => void refreshed.push(id),
    settings: async () => ({ enabled: true, seconds: 15 }),
    covered: async () => new Set(),
    setTimer: (fn, ms) => {
      const t = { fn: () => { t.live = false; fn(); }, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { live: boolean }).live = false),
    ...over,
  });
  /** One full round over the watched repositories, finishing each probe before the next step. */
  const round = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await w.step();
      await w.settle();
    }
  };
  return { w, gh, clock, refreshed, timers, round };
}

beforeEach(async () => {
  await truncateAll(db);
  const p = await ensureLocalProfile(db, { id: 4242n, login: "me", name: "Me", avatarUrl: null, host: "github.com" });
  ws = p.workspace.id;
  owner = (await db.githubOwner.create({ data: { githubId: 99n, login: "Jozkah", type: "USER" } })).id;
  h.user = p.user;
  h.viewer = { isAdmin: false, workspaceId: ws };
  delete process.env.MERGEPORT_WATCH_SECONDS;
  resetEnvCache();
});
afterEach(() => {
  delete process.env.MERGEPORT_WATCH_SECONDS;
  resetEnvCache();
});

describe("probing with ETags", () => {
  it("the first answer only records the ETag; a 304 triggers nothing", async () => {
    const r = await addRepo("Jozkah/mergeport");
    const s = setup();
    await s.round(1);
    expect(s.gh.calls.map((c) => [c.kind, c.sent])).toEqual([["issues", null], ["commits", null]]);
    expect(s.refreshed).toEqual([]);
    await s.round(1);
    expect(s.gh.calls.slice(2).every((c) => c.sent !== null)).toBe(true); // conditional now
    expect(s.refreshed).toEqual([]);
    expect(r.id).toBeTruthy();
  });

  it("a changed ETag on either probe triggers exactly one refresh request", async () => {
    const r = await addRepo("Jozkah/mergeport");
    const s = setup();
    await s.round(2);
    s.gh.bump("Jozkah/mergeport", "issues");
    await s.round(1);
    expect(s.refreshed).toEqual([r.id]);
    await s.round(1); // the new ETag is the baseline now
    expect(s.refreshed).toEqual([r.id]);
    s.clock.t += MIN_REFRESH_GAP_MS;
    s.gh.bump("Jozkah/mergeport", "commits");
    await s.round(1);
    expect(s.refreshed).toEqual([r.id, r.id]);
  });

  it("a burst of changes respects the 30 s gap and is not lost", async () => {
    const r = await addRepo("Jozkah/mergeport");
    const s = setup();
    await s.round(2);
    s.gh.bump("Jozkah/mergeport", "issues");
    await s.round(1);
    expect(s.refreshed).toHaveLength(1);
    s.clock.t += 10_000;
    s.gh.bump("Jozkah/mergeport", "issues");
    await s.round(1);
    expect(s.refreshed).toHaveLength(1); // too soon
    s.clock.t += 10_000;
    await s.round(1);
    expect(s.refreshed).toHaveLength(1);
    s.clock.t += 10_000;
    await s.round(1); // 30 s after the first refresh: the pending one goes out
    expect(s.refreshed).toEqual([r.id, r.id]);
    await s.round(1);
    expect(s.refreshed).toHaveLength(2);
  });

  it("empty repositories and disabled issues (409, 410) are not failures", async () => {
    await addRepo("Jozkah/empty");
    const s = setup();
    s.gh.fail("Jozkah/empty", () => new Response("{}", { status: 409 }));
    await s.round(3);
    expect(s.gh.calls.length).toBe(6); // never backed off
  });
});

describe("which repositories", () => {
  it("excludes covered, demo, disconnected repositories", async () => {
    await addRepo("a/one", { githubId: 1n });
    await addRepo("a/covered", { githubId: 2n });
    await addRepo("a/demo", { demo: true, githubId: 3n });
    await addRepo("a/paused", { status: "DISCONNECTED", githubId: 4n });
    const t = await watchTargets(db, new Set(["2"]));
    expect(t.map((x) => x.fullName)).toEqual(["a/one"]);
  });

  it("caps at 20, least recently synced first", async () => {
    for (let i = 0; i < 25; i++) await addRepo(`a/r${String(i).padStart(2, "0")}`, { synced: new Date(Date.UTC(2026, 0, 1, 0, i)) });
    const t = await watchTargets(db, new Set());
    expect(t).toHaveLength(WATCH_MAX_REPOS);
    expect(t[0].fullName).toBe("a/r00");
    expect(t.at(-1)!.fullName).toBe("a/r19");
  });

  it("GitHub-only profile (no hub): nothing is covered, so everything is watched; with a hub the reported ids are covered", async () => {
    await addRepo("a/one", { githubId: 1n });
    await saveHubCoverage(db, ["1"]);
    expect([...(await coveredIds(db, "github"))]).toEqual([]);
    expect([...(await coveredIds(db, HUB))]).toEqual(["1"]);
    const s = setup({ covered: () => coveredIds(db, "github") });
    await s.round(1);
    expect(s.gh.calls.length).toBe(2);
  });

  it("watchView reports the repositories and never includes Instant ones", async () => {
    await addRepo("a/one", { githubId: 1n });
    await addRepo("a/two", { githubId: 2n });
    const v = await watchView(db, new Set(["2"]));
    expect([...v.ids]).toEqual(["1"]);
    expect(v.summary).toMatchObject({ enabled: true, configured: 15, effective: 15, repos: 1, stretched: false });
  });
});

describe("pacing", () => {
  it("does not poll while the browser is idle", async () => {
    await addRepo("a/one");
    const s = setup({ isActive: () => false });
    await s.round(3);
    expect(s.gh.calls).toEqual([]);
  });

  it("spreads probes evenly across the interval (with jitter) and starts at most 2 in flight", async () => {
    for (let i = 0; i < 6; i++) await addRepo(`a/r${i}`);
    let r = 0.5;
    const s = setup({ settings: async () => ({ enabled: true, seconds: 30 }), random: () => r });
    expect(await s.w.step()).toBe(5000); // 30 s / 6 repositories
    await s.w.settle();
    r = 0;
    expect(await s.w.step()).toBe(4000); // -20 %
    r = 1;
    expect(await s.w.step()).toBe(6000); // +20 %
    await s.w.settle();
    expect(s.gh.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT * 1);
    // never more than 2 probe units at once even if steps arrive back to back
    const s2 = setup();
    for (let i = 0; i < 6; i++) void s2.w.step();
    await new Promise((res) => setTimeout(res, 0));
    expect(s2.w.inFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    await s2.w.settle();
  });

  it("backs off exponentially after errors, up to 10 minutes, and never throws", async () => {
    await addRepo("a/gone");
    const s = setup({ settings: async () => ({ enabled: true, seconds: 15 }) });
    s.gh.fail("a/gone", () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    await s.round(1); // 1st failure: wait 30 s
    const n1 = s.gh.calls.length;
    s.clock.t += 29_000;
    await s.round(1);
    expect(s.gh.calls.length).toBe(n1); // still backing off
    s.clock.t += 2_000;
    await s.round(1); // 2nd failure: wait 60 s
    const n2 = s.gh.calls.length;
    expect(n2).toBeGreaterThan(n1);
    s.clock.t += 59_000;
    await s.round(1);
    expect(s.gh.calls.length).toBe(n2);
    for (let i = 0; i < 12; i++) {
      s.clock.t += MAX_BACKOFF_MS + 1;
      await s.round(1);
    }
    s.clock.t += MAX_BACKOFF_MS - 1000; // capped: 10 minutes at most
    const n3 = s.gh.calls.length;
    await s.round(1);
    expect(s.gh.calls.length).toBe(n3);
    s.clock.t += 1001;
    await s.round(1);
    expect(s.gh.calls.length).toBeGreaterThan(n3);
    // a repository that recovers is probed normally again
    s.gh.fail("a/gone", null);
    s.clock.t += MAX_BACKOFF_MS + 1;
    await s.round(2);
    expect(s.refreshed).toEqual([]);
  });

  it("a rate limit pauses the whole watcher until the reset time", async () => {
    await addRepo("a/one");
    await addRepo("a/two");
    const s = setup();
    const reset = Math.floor((s.clock.t + 120_000) / 1000);
    s.gh.fail("a/one", () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }));
    await s.round(2);
    const n = s.gh.calls.length;
    expect(s.w.pausedUntil).toBe(reset * 1000);
    s.clock.t += 60_000;
    await s.round(3);
    expect(s.gh.calls.length).toBe(n); // nothing at all, not even the other repository
    s.gh.fail("a/one", null);
    s.clock.t = reset * 1000 + 1;
    await s.round(2);
    expect(s.gh.calls.length).toBeGreaterThan(n);
  });

  it("retry-after also pauses", async () => {
    await addRepo("a/one");
    const s = setup();
    s.gh.fail("a/one", () => new Response("{}", { status: 429, headers: { "retry-after": "90" } }));
    await s.round(1);
    expect(s.w.pausedUntil).toBe(s.clock.t + 90_000);
  });
});

describe("lifecycle", () => {
  it("start schedules a timer; stop clears it and later steps do nothing", async () => {
    await addRepo("a/one");
    const s = setup();
    s.w.start();
    expect(s.timers.filter((t) => t.live)).toHaveLength(1);
    s.timers[0].fn();
    await new Promise((res) => setTimeout(res, 5));
    await s.w.settle();
    const live = s.timers.filter((t) => t.live);
    expect(live).toHaveLength(1);
    s.w.stop();
    expect(s.timers.filter((t) => t.live)).toHaveLength(0);
    expect(s.w.running).toBe(false);
    live[0].fn(); // a stale timer firing after stop schedules nothing
    await new Promise((res) => setTimeout(res, 5));
    expect(s.timers.filter((t) => t.live)).toHaveLength(0);
  });

  it("nothing starts under vitest by itself", async () => {
    const { startRepoWatch } = await import("@/lib/local/repo-watch");
    expect(startRepoWatch()).toBeNull();
  });
});

describe("settings: budget, precedence, switch, next cycle", () => {
  it("budget: few repositories honour the setting, many are stretched (300 requests a minute)", () => {
    expect(effectiveWatchSeconds(2, 3)).toBe(2);
    expect(effectiveWatchSeconds(15, 20)).toBe(15);
    expect(effectiveWatchSeconds(2, 20)).toBe(8);
    expect(effectiveWatchSeconds(2, 10)).toBe(4);
    expect(effectiveWatchSeconds(2, 1)).toBe(2);
  });

  it("words for the pill use the effective interval", () => {
    expect(watchLabel(15)).toBe("~15 s");
    expect(watchTitle(15)).toBe("Checked about every 15 seconds while Mergeport is open");
    expect(watchLabel(120)).toBe("~2 min");
  });

  it("precedence: database value wins, else a valid env value, else 15; invalid env falls back to 15", async () => {
    expect(await readWatchSettings(db)).toEqual({ enabled: true, seconds: 15, maxRepos: 20 });
    process.env.MERGEPORT_WATCH_SECONDS = "7";
    resetEnvCache();
    expect((await readWatchSettings(db)).seconds).toBe(7);
    for (const bad of ["1", "0", "abc", "301", "", "2.5"]) {
      process.env.MERGEPORT_WATCH_SECONDS = bad;
      resetEnvCache();
      expect((await readWatchSettings(db)).seconds).toBe(15);
    }
    process.env.MERGEPORT_WATCH_SECONDS = "2";
    resetEnvCache();
    expect((await readWatchSettings(db)).seconds).toBe(2); // minimum
    await saveWatchSettings(db, { enabled: true, seconds: 40 });
    expect((await readWatchSettings(db)).seconds).toBe(40); // the saved value wins
  });

  it("switch off stops probing; a change is picked up at the next cycle", async () => {
    await addRepo("a/one");
    await addRepo("a/two");
    await saveWatchSettings(db, { enabled: true, seconds: 20 });
    const s = setup({ settings: () => readWatchSettings(db) });
    expect(await s.w.step()).toBe(10_000); // 20 s / 2 repositories
    await s.w.settle();
    await saveWatchSettings(db, { enabled: true, seconds: 60 });
    expect(await s.w.step()).toBe(10_000); // still inside the running cycle
    await s.w.settle();
    expect(await s.w.step()).toBe(30_000); // new cycle: 60 s / 2
    await s.w.settle();
    await saveWatchSettings(db, { enabled: false, seconds: 60 });
    await s.w.step();
    await s.w.step(); // end of the cycle
    await s.w.settle();
    const n = s.gh.calls.length;
    await s.round(4);
    expect(s.gh.calls.length).toBe(n);
  });

  it("max repositories: precedence null / env / database, bounds, and invalid env", async () => {
    expect((await readWatchSettings(db)).maxRepos).toBe(20);
    process.env.MERGEPORT_WATCH_MAX_REPOS = "50";
    resetEnvCache();
    expect((await readWatchSettings(db)).maxRepos).toBe(50);
    for (const bad of ["0", "201", "x", "", "3.5"]) {
      process.env.MERGEPORT_WATCH_MAX_REPOS = bad;
      resetEnvCache();
      expect((await readWatchSettings(db)).maxRepos).toBe(20);
    }
    process.env.MERGEPORT_WATCH_MAX_REPOS = "200";
    resetEnvCache();
    expect((await readWatchSettings(db)).maxRepos).toBe(200);
    await saveWatchSettings(db, { enabled: true, seconds: 15, maxRepos: 7 });
    expect((await readWatchSettings(db)).maxRepos).toBe(7);
    delete process.env.MERGEPORT_WATCH_MAX_REPOS;
    resetEnvCache();
    expect(parseWatchMaxRepos("1")).toBe(1);
    expect(parseWatchMaxRepos("200")).toBe(200);
    for (const bad of ["0", "201", "abc", "", "1.5"]) expect(() => parseWatchMaxRepos(bad)).toThrow(/from 1 to 200/);
  });

  it("the cap applies to the watched set and a change is picked up next cycle; a large cap stretches the interval", async () => {
    for (let i = 0; i < 30; i++) await addRepo(`a/r${String(i).padStart(2, "0")}`, { synced: new Date(Date.UTC(2026, 0, 1, 0, i)) });
    await saveWatchSettings(db, { enabled: true, seconds: 10, maxRepos: 3 });
    const s = setup({ settings: () => readWatchSettings(db) });
    await s.round(3); // one cycle over the 3 least recently synced
    expect([...new Set(s.gh.calls.map((c) => c.repo))].sort()).toEqual(["a/r00", "a/r01", "a/r02"]);
    await saveWatchSettings(db, { enabled: true, seconds: 10, maxRepos: 25 });
    expect(await s.w.step()).toBe(Math.round((10_000 * 1) / 25) === 400 ? 10_000 / 25 : 0); // 25 repositories: 25 * 0.4 = 10 s, so not stretched yet
    await s.w.settle();
    await saveWatchSettings(db, { enabled: true, seconds: 10, maxRepos: 30 });
    for (let i = 0; i < 24; i++) await s.w.step(); // finish this cycle of 25
    await s.w.settle();
    expect(await s.w.step()).toBe(400); // 30 repositories: 12 s / 30
    await s.w.settle();
    expect(new Set(s.gh.calls.map((c) => c.repo)).size).toBeGreaterThan(3);
    const v = await watchView(db);
    expect(v.summary).toMatchObject({ maxRepos: 30, repos: 30, configured: 10, effective: 12, stretched: true });
  });

  it("the effective interval reaches the UI (watchView), stretched when many repositories are watched", async () => {
    for (let i = 0; i < 12; i++) await addRepo(`a/r${i}`);
    await saveWatchSettings(db, { enabled: true, seconds: 2 });
    const v = await watchView(db);
    expect(v.summary).toMatchObject({ configured: 2, effective: 5, repos: 12, stretched: true });
    await saveWatchSettings(db, { enabled: false, seconds: 2 });
    expect((await watchView(db)).ids.size).toBe(0);
  });
});

describe("setRepoWatchAction", () => {
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };

  it("saves a valid value and the switch", async () => {
    const { setRepoWatchAction } = await import("@/app/actions");
    const r = await setRepoWatchAction(form({ enabled: "on", seconds: "30", max: "12" }));
    expect(r.ok).toBe(true);
    expect(await readWatchSettings(db)).toEqual({ enabled: true, seconds: 30, maxRepos: 12 });
    await setRepoWatchAction(form({ seconds: "2", max: "12" })); // switch unchecked: absent
    expect(await readWatchSettings(db)).toEqual({ enabled: false, seconds: 2, maxRepos: 12 });
  });

  it("refuses out-of-range and non-numeric input with a plain sentence and saves nothing", async () => {
    const { setRepoWatchAction } = await import("@/app/actions");
    for (const bad of ["1", "301", "abc", "", "-5", "10.5"]) {
      const r = await setRepoWatchAction(form({ enabled: "on", seconds: bad, max: "12" }));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain("Enter a whole number of seconds from 2 to 300.");
    }
    for (const bad of ["0", "201", "x", ""]) {
      const r = await setRepoWatchAction(form({ enabled: "on", seconds: "30", max: bad }));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain("Enter a whole number of repositories from 1 to 200.");
    }
    expect(await db.teamConfig.findUnique({ where: { id: "team" } })).toMatchObject({ watchSeconds: null });
    expect(() => parseWatchSeconds("0")).toThrow(ValidationError);
  });

  it("needs a signed-in viewer", async () => {
    const { setRepoWatchAction } = await import("@/app/actions");
    const saved = h.viewer;
    h.viewer = null;
    const r = await setRepoWatchAction(form({ enabled: "on", seconds: "30", max: "12" }));
    expect(r.ok).toBe(false);
    expect((await readWatchSettings(db)).seconds).toBe(15);
    h.viewer = saved;
  });
});

describe("pages", () => {
  it("Settings shows the controls with the effective value and the stretch note", async () => {
    for (let i = 0; i < 20; i++) await addRepo(`a/r${i}`);
    await saveWatchSettings(db, { enabled: true, seconds: 2 });
    const Page = (await import("@/app/(app)/settings/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Auto-sync of repositories");
    expect(html).toContain("Check repositories I don&#x27;t own while Mergeport is open");
    expect(html).toContain("Check every (seconds)");
    expect(html).toMatch(/name="seconds"[^>]*value="2"/);
    expect(html).toContain("Webhook-covered repositories are never polled.");
    expect(html).toContain("Effective: every 8 s for 20 repositories.");
    expect(html).toContain("Stretched from 2 s");
    expect(html).toContain("Watch at most (repositories)");
    expect(html).toMatch(/name="max"[^>]*value="20"/);
  });

  it("RepoList shows the pill for watched repositories only, not for Instant ones", async () => {
    const { RepoList } = await import("@/components/repos/RepoList");
    const base = { ownerLogin: "o", ownerAvatar: null, ownerType: "USER", visibility: "PUBLIC", access: { label: "Read", detail: "" }, archived: false, demo: false, fork: null, openItems: 1, status: "ok", statusDetail: null, synced: "synced 1m ago", spaceId: null, spaceName: null, canUnshare: false, projects: [] };
    const watch = { label: "Auto-sync ~15 s", title: "Checked about every 15 seconds while Mergeport is open" };
    const rows = [
      { ...base, id: "1", name: "watched", fullName: "o/watched", instant: false, watch },
      { ...base, id: "2", name: "instant", fullName: "o/instant", instant: true, watch },
      { ...base, id: "3", name: "plain", fullName: "o/plain", instant: false, watch: null },
    ];
    const html = renderToStaticMarkup(createElement(RepoList, { rows, writable: [] } as never));
    expect(html.match(/Auto-sync ~15 s/g)).toHaveLength(1);
    expect(html).toContain('title="Checked about every 15 seconds while Mergeport is open"');
  });
});
