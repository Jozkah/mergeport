import type { Db } from "@/lib/db";
import { db as appDb } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ghFetch } from "@/lib/github/gh";
import { GithubError } from "@/lib/github/port";
import { GitHubRest } from "@/lib/github/rest";
import { readAllCoverage } from "@/lib/hub/github-app-install";
import { COVERAGE_KEY } from "@/lib/hub/webhook-panel";
import { pollMode } from "@/lib/local/activity";
import { isHubBackend } from "@/lib/local/backends";
import { fromJson } from "@/lib/local/discovery";
import { profileRunner } from "@/lib/local/profile-runner";
import { readWatchSettings } from "@/lib/local/watch-settings";
import { WATCH_MAX_REPOS, effectiveWatchSeconds, watchSummary, type WatchSummary } from "@/lib/local/watch-format";
import { currentBackend } from "@/lib/local/workspaces";
import { requestRepositoryRefresh } from "@/lib/services/refresh";

/**
 * Auto-sync watcher for repositories that can never send webhooks (public repositories the person does not own, anything the
 * hub's GitHub App does not cover). While a browser tab is open it probes each such repository with two conditional requests,
 * the issues list sorted by last update and the latest commit, each with the ETag of the previous answer. A 304 costs no rate
 * limit and does nothing; a different ETag asks for a refresh of that repository through the same job as the Refresh button.
 * The 15-minute reconcile stays the safety net: nothing here is required for correctness.
 */

export const MIN_REFRESH_GAP_MS = 30_000;
export const MAX_BACKOFF_MS = 600_000;
export const MAX_IN_FLIGHT = 2;
const RECHECK_MS = 5_000;
const BUSY_MS = 250;

export type WatchTarget = { id: string; githubId: string; fullName: string };

export type RepoWatchDeps = {
  db: Db;
  now: () => number;
  random: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Is a browser tab open and recently active. */
  isActive: () => boolean;
  /** GitHub REST access of this profile; null when there is none (demo, signed out). */
  rest: () => Promise<GitHubRest | null>;
  refresh: (repositoryId: string) => Promise<unknown>;
  settings: () => Promise<{ enabled: boolean; seconds: number; maxRepos?: number }>;
  /** GitHub ids covered by the hub's App. Empty without a hub. */
  covered: () => Promise<Set<string>>;
};

/** GitHub ids the hub's App is known to cover; nothing is covered without a hub workspace. */
export async function coveredIds(db: Db, backend?: string): Promise<Set<string>> {
  try {
    if (!isHubBackend(backend ?? (await currentBackend()))) return new Set();
    let slug: string | null = null;
    const legacy = await db.discoveryCache.findUnique({ where: { key: COVERAGE_KEY } });
    if (legacy?.payload) slug = fromJson<{ appSlug?: string }>(legacy.payload)?.appSlug ?? null;
    return await readAllCoverage(db, slug);
  } catch {
    return new Set();
  }
}

/** Active, real, not covered, the least recently synced first, at most `max` (default 20). */
export async function watchTargets(db: Db, covered: Set<string>, max = WATCH_MAX_REPOS): Promise<WatchTarget[]> {
  const rows = await db.repository.findMany({
    where: { trackingStatus: "ACTIVE", isDemo: false },
    select: { id: true, githubId: true, fullName: true, lastSyncedAt: true },
    orderBy: [{ lastSyncedAt: "asc" }, { fullName: "asc" }],
  });
  return rows
    .filter((r) => !covered.has(r.githubId.toString()) && /^[^/]+\/[^/]+$/.test(r.fullName))
    .slice(0, max)
    .map((r) => ({ id: r.id, githubId: r.githubId.toString(), fullName: r.fullName }));
}

/** For the pages: which repositories the watcher covers (by GitHub id) and the numbers to show. `instant` ones are never watched. */
export async function watchView(db: Db, instant: Set<string> = new Set()): Promise<{ ids: Set<string>; summary: WatchSummary }> {
  const settings = await readWatchSettings(db);
  const targets = (await watchTargets(db, new Set([...(await coveredIds(db)), ...instant]), settings.maxRepos)).filter((t) => !instant.has(t.githubId));
  return { ids: settings.enabled ? new Set(targets.map((t) => t.githubId)) : new Set(), summary: watchSummary(settings.enabled, settings.seconds, targets.length, settings.maxRepos) };
}

type Probe = "issues" | "commits";
type RepoState = { etags: Partial<Record<Probe, string>>; failures: number; backoffUntil: number; lastRefresh: number; pending: boolean };

export function createRepoWatcher(over: Partial<RepoWatchDeps> & { db: Db }) {
  const d: RepoWatchDeps = {
    now: Date.now,
    random: Math.random,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    isActive: () => pollMode() === "active",
    rest: (() => {
      let rest: GitHubRest | undefined;
      return async () => {
        if (isDemo()) return null;
        if (!(await over.db.user.findFirst({ where: { isDemo: false }, select: { id: true } }))) return null;
        return (rest ??= new GitHubRest(ghFetch(profileRunner(over.db))));
      };
    })(),
    refresh: (id) => requestRepositoryRefresh(over.db, id),
    settings: () => readWatchSettings(over.db),
    covered: () => coveredIds(over.db),
    ...over,
  };
  const states = new Map<string, RepoState>();
  let round: WatchTarget[] = [];
  let index = 0;
  let intervalMs = 15_000;
  let pausedUntil = 0;
  let inFlight = 0;
  let timer: unknown;
  let stopped = true;
  const running = new Set<Promise<void>>();

  const stateOf = (id: string): RepoState => {
    let s = states.get(id);
    if (!s) states.set(id, (s = { etags: {}, failures: 0, backoffUntil: 0, lastRefresh: -Infinity, pending: false }));
    return s;
  };

  async function probe(t: WatchTarget): Promise<void> {
    const st = stateOf(t.id);
    try {
      const rest = await d.rest();
      if (!rest) return;
      const [owner, name] = t.fullName.split("/").map(encodeURIComponent);
      const paths: Record<Probe, string> = {
        issues: `/repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=1`,
        commits: `/repos/${owner}/${name}/commits?per_page=1`,
      };
      for (const kind of ["issues", "commits"] as const) {
        const prev = st.etags[kind];
        // 409 (empty repository) and 410 (issues disabled) are normal answers, not failures.
        const r = await rest.get(paths[kind], { headers: prev ? { "if-none-match": prev } : {}, allow: [409, 410] });
        if (r.status !== 200) continue;
        const etag = r.headers.get("etag");
        if (!etag) continue;
        st.etags[kind] = etag;
        if (prev !== undefined && prev !== etag) st.pending = true;
      }
      st.failures = 0;
      st.backoffUntil = 0;
      if (st.pending && d.now() - st.lastRefresh >= MIN_REFRESH_GAP_MS) {
        st.pending = false;
        st.lastRefresh = d.now();
        await d.refresh(t.id).catch(() => {}); // the 15-minute cycle will catch up
      }
    } catch (e) {
      const now = d.now();
      if (e instanceof GithubError && e.kind === "rate-limited") {
        pausedUntil = Math.max(pausedUntil, e.resetAt?.getTime() ?? now + (e.retryAfterSeconds ?? 60) * 1000);
      } else {
        st.failures++;
        st.backoffUntil = now + Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** st.failures);
      }
    }
  }

  /** One scheduling step: starts at most one repository's probe. Returns the delay until the next step. Never throws. */
  async function step(): Promise<number> {
    try {
      const now = d.now();
      if (!d.isActive()) {
        round = [];
        return RECHECK_MS;
      }
      if (pausedUntil > now) return Math.min(pausedUntil - now, 60_000);
      if (index >= round.length) {
        // Start of a cycle: read the settings again, so a change applies within one interval.
        const s = await d.settings();
        round = s.enabled ? await watchTargets(d.db, await d.covered(), s.maxRepos) : [];
        index = 0;
        for (const id of states.keys()) if (!round.some((r) => r.id === id)) states.delete(id);
        if (round.length === 0) return RECHECK_MS;
        intervalMs = effectiveWatchSeconds(s.seconds, round.length) * 1000;
      }
      if (inFlight >= MAX_IN_FLIGHT) return BUSY_MS;
      const t = round[index++];
      const st = stateOf(t.id);
      if (st.backoffUntil <= now) {
        inFlight++;
        const p = probe(t).finally(() => {
          inFlight--;
          running.delete(p);
        });
        running.add(p);
      }
      // Even spacing: interval / repositories, with +-20% jitter.
      return Math.max(50, Math.round((intervalMs / Math.max(1, round.length)) * (0.8 + 0.4 * d.random())));
    } catch {
      return RECHECK_MS; // a database hiccup must never reach the scheduler
    }
  }

  function loop() {
    timer = undefined;
    if (stopped) return;
    void step().then((delay) => {
      if (!stopped) timer = d.setTimer(loop, delay);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = d.setTimer(loop, 0);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) d.clearTimer(timer);
      timer = undefined;
      round = [];
      index = 0;
    },
    step,
    /** Resolves when every started probe has finished (tests). */
    async settle() {
      while (running.size) await Promise.all([...running]);
    },
    get inFlight() {
      return inFlight;
    },
    get pausedUntil() {
      return pausedUntil;
    },
    get running() {
      return !stopped;
    },
  };
}

export type RepoWatcher = ReturnType<typeof createRepoWatcher>;

type G = typeof globalThis & { __mpRepoWatch?: RepoWatcher };

/** Starts the process-wide watcher (idempotent). Not under vitest unless a test starts its own. */
export function startRepoWatch(): RepoWatcher | null {
  const g = globalThis as G;
  if (process.env.VITEST) return null;
  if (!g.__mpRepoWatch) {
    g.__mpRepoWatch = createRepoWatcher({ db: appDb });
    g.__mpRepoWatch.start();
  }
  return g.__mpRepoWatch;
}

export function stopRepoWatch(): void {
  const g = globalThis as G;
  g.__mpRepoWatch?.stop();
  g.__mpRepoWatch = undefined;
}
