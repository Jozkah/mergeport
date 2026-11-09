import type { Db } from "@/lib/db";
import { db as appDb } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ghFetch } from "@/lib/github/gh";
import { GithubError } from "@/lib/github/port";
import { GitHubRest } from "@/lib/github/rest";
import { readAllCoverage, readHubWebhooksEnabled } from "@/lib/hub/github-app-install";
import { COVERAGE_KEY, HUB_COVERAGE_KEY } from "@/lib/hub/webhook-panel";
import { pollMode } from "@/lib/local/activity";
import { isHubBackend } from "@/lib/local/backends";
import { fromJson } from "@/lib/local/discovery";
import { profileRunner } from "@/lib/local/profile-runner";
import { readWatchConfig, readWatchSettings, type WatchConfig } from "@/lib/local/watch-settings";
import { WATCH_MAX_REPOS, effectiveWatchSeconds, watchSummary, type WatchSummary } from "@/lib/local/watch-format";
import { currentBackend } from "@/lib/local/workspaces";
import { requestRepositoryRefresh } from "@/lib/services/refresh";

/**
 * Auto-sync watcher for repositories that can never send webhooks (public repositories the person does not own, anything the
 * hub's GitHub App does not cover). While a browser tab is open it probes each such repository with two conditional requests,
 * the issues list sorted by last update (pull requests are issues too, and a review bumps their updated_at) and the latest
 * commit of the default branch, each with the ETag of the previous answer. A 304 costs no rate limit and does nothing; a
 * different ETag asks for an incremental refresh of that repository through the same job as the Refresh button. Releases, tags
 * and other branches are not probed: they wait for the 15-minute reconcile, which stays the safety net.
 */

export const MIN_REFRESH_GAP_MS = 30_000;
export const MAX_BACKOFF_MS = 600_000;
export const MIN_RATE_PAUSE_S = 60;
export const MAX_IN_FLIGHT = 2;
/** Most watcher-triggered refresh jobs queued or running at once. */
export const MAX_REFRESHES = 2;
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
  /** Enqueues an incremental refresh. Rejecting means "not enqueued": the change stays pending. */
  refresh: (repositoryId: string) => Promise<unknown>;
  /** Is the refresh job of that repository still queued or running. */
  refreshPending: (repositoryId: string) => Promise<boolean>;
  settings: () => Promise<{ enabled: boolean; seconds: number; maxRepos?: number }>;
  /** GitHub ids the hub's App covers while its webhooks are enabled; empty without a hub; null when it could not be read. */
  covered: () => Promise<Set<string> | null>;
};

/**
 * GitHub ids that get instant updates, so need no watching: covered by the hub's App AND the hub's webhooks are enabled
 * (as last seen in `me()`, stored locally; the watcher never asks the hub). Nothing is covered without a hub workspace.
 * Null when the database could not be read (callers skip the cycle or keep the last known set; never "nothing covered").
 */
export async function coveredIds(db: Db, backend?: string): Promise<Set<string> | null> {
  try {
    if (!isHubBackend(backend ?? (await currentBackend()))) return new Set();
    if (!(await readHubWebhooksEnabled(db))) return new Set();
    const legacy = await db.discoveryCache.findUnique({ where: { key: COVERAGE_KEY } });
    const slug = legacy?.payload ? (fromJson<{ appSlug?: string }>(legacy.payload)?.appSlug ?? null) : null;
    await db.discoveryCache.findUnique({ where: { key: HUB_COVERAGE_KEY } }); // readAllCoverage swallows read errors; this one must not
    return await readAllCoverage(db, slug);
  } catch {
    return null;
  }
}

/** Every active, real, uncovered repository, the least recently synced first. */
export async function watchEligible(db: Db, covered: Set<string>): Promise<WatchTarget[]> {
  const rows = await db.repository.findMany({
    where: { trackingStatus: "ACTIVE", isDemo: false },
    select: { id: true, githubId: true, fullName: true, lastSyncedAt: true },
    orderBy: [{ lastSyncedAt: "asc" }, { fullName: "asc" }],
  });
  return rows.filter((r) => !covered.has(r.githubId.toString()) && /^[^/]+\/[^/]+$/.test(r.fullName)).map((r) => ({ id: r.id, githubId: r.githubId.toString(), fullName: r.fullName }));
}

/** The watched set: the eligible repositories capped at `max` (default 20). */
export async function watchTargets(db: Db, covered: Set<string>, max = WATCH_MAX_REPOS): Promise<WatchTarget[]> {
  return (await watchEligible(db, covered)).slice(0, max);
}

/** For the pages: which repositories the watcher covers (by GitHub id) and the numbers to show. `instant` ones are never watched. */
export async function watchView(db: Db, instant: Set<string> = new Set()): Promise<{ ids: Set<string>; summary: WatchSummary; config: WatchConfig }> {
  const config = await readWatchConfig(db);
  const covered = (await coveredIds(db)) ?? new Set<string>();
  const targets = (await watchTargets(db, new Set([...covered, ...instant]), config.maxRepos)).filter((t) => !instant.has(t.githubId));
  return { ids: config.enabled ? new Set(targets.map((t) => t.githubId)) : new Set(), summary: watchSummary(config.enabled, config.seconds, targets.length, config.maxRepos), config };
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
    refresh: (id) => requestRepositoryRefresh(over.db, id, { full: false }),
    refreshPending: async (id) => {
      const job = await over.db.job.findFirst({ where: { type: "sync.repository", dedupeKey: `sync:${id}`, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
      return job !== null;
    },
    settings: () => readWatchSettings(over.db),
    covered: () => coveredIds(over.db),
    ...over,
  };
  const states = new Map<string, RepoState>();
  /** Repositories this watcher asked to refresh and whose job may still be running. */
  const outstanding = new Set<string>();
  let lastCovered: Set<string> | null = null;
  let round: WatchTarget[] = [];
  let index = 0;
  let intervalMs = 15_000;
  let pausedUntil = 0;
  let inFlight = 0;
  let timer: unknown;
  let stopped = true;
  /** Bumped by start() and stop(): a loop or step belonging to an older generation does nothing more. */
  let gen = 0;
  const running = new Set<Promise<void>>();

  const stateOf = (id: string): RepoState => {
    let s = states.get(id);
    if (!s) states.set(id, (s = { etags: {}, failures: 0, backoffUntil: 0, lastRefresh: -Infinity, pending: false }));
    return s;
  };

  /** Enqueues the pending refresh when the gap and the cap allow it; a failure to enqueue keeps it pending. */
  async function maybeRefresh(id: string, st: RepoState): Promise<void> {
    if (!st.pending || d.now() - st.lastRefresh < MIN_REFRESH_GAP_MS) return;
    for (const o of [...outstanding]) if (!(await d.refreshPending(o).catch(() => true))) outstanding.delete(o);
    if (outstanding.size >= MAX_REFRESHES && !outstanding.has(id)) return; // later: the change stays pending
    try {
      await d.refresh(id);
    } catch {
      return; // not enqueued: keep `pending`, the next probe tries again
    }
    st.pending = false;
    st.lastRefresh = d.now();
    outstanding.add(id);
  }

  function fail(st: RepoState, now: number) {
    st.failures++;
    st.backoffUntil = now + Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** st.failures);
  }

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
      await maybeRefresh(t.id, st);
    } catch (e) {
      const now = d.now();
      if (e instanceof GithubError && e.kind === "rate-limited") {
        // Relative to our own clock: the reset header is not trusted on its own (clock skew), 60 s at least.
        pausedUntil = Math.max(pausedUntil, now + Math.max(e.retryAfterSeconds ?? MIN_RATE_PAUSE_S, MIN_RATE_PAUSE_S) * 1000);
      }
      fail(st, now);
    }
  }

  /** One scheduling step: starts at most one repository's probe. Returns the delay until the next step. Never throws. */
  async function stepFor(g: number): Promise<number> {
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
        let covered = await d.covered();
        if (g !== gen) return RECHECK_MS;
        if (covered) lastCovered = covered;
        else covered = lastCovered; // unreadable: keep the last known set, or skip this cycle when there is none
        if (!covered) return RECHECK_MS;
        const eligible = s.enabled ? await watchEligible(d.db, covered) : [];
        if (g !== gen) return RECHECK_MS;
        round = eligible.slice(0, s.maxRepos ?? WATCH_MAX_REPOS);
        index = 0;
        // Baselines are pruned against everything eligible, not the capped round: a repository that falls out of the cap
        // and comes back keeps its ETags and its pending change.
        const keep = new Set(eligible.map((r) => r.id));
        for (const id of [...states.keys()]) if (!keep.has(id)) states.delete(id);
        for (const id of [...outstanding]) if (!keep.has(id)) outstanding.delete(id);
        if (round.length === 0) return RECHECK_MS;
        intervalMs = effectiveWatchSeconds(s.seconds, round.length) * 1000;
      }
      if (g !== gen) return RECHECK_MS;
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

  function loop(g: number) {
    if (g !== gen) return; // a loop of an older generation (stop() or start() happened since) ends here
    timer = undefined;
    void stepFor(g).then((delay) => {
      if (g === gen && !stopped) timer = d.setTimer(() => loop(g), delay);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      const g = ++gen;
      timer = d.setTimer(() => loop(g), 0);
    },
    stop() {
      stopped = true;
      gen++;
      if (timer !== undefined) d.clearTimer(timer);
      timer = undefined;
      round = [];
      index = 0;
    },
    step: () => stepFor(gen),
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
    /** Tests: the remembered state of a repository. */
    baseline: (id: string) => states.get(id),
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
