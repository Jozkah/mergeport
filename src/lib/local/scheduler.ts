import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ensureRecurring, reclaimStuck, runOne, type Handler } from "@/lib/jobs";
import { MAINTENANCE_EVERY_MS } from "@/lib/github/webhook-maintenance";
import { AI_AUTOPILOT_EVERY_MS, DIGEST_EVERY_MS, RECONCILE_EVERY_MS, handlers } from "@/lib/local/handlers";
import { notifyChange } from "@/lib/local/runtime";

/**
 * Background work of the worker process (scripts/worker.ts). It runs while the process runs, and only then.
 *
 * Two independent lanes, each with its own busy flag, so a slow run in one never delays the other:
 *   1. coordination (scheduling the recurring jobs, reclaiming stuck ones)
 *   2. jobs (the queue: issues, PRs, comments, branches, fork comparisons, the daily digest)
 */

/** Reconcile cadence in idle mode: every repository is still checked, just less often. */
export const RECONCILE_IDLE_EVERY_MS = 60 * 60_000;
/** The first reconcile after start waits this long, so starting the app (often at logon) is not a burst of requests. */
export const RECONCILE_START_DELAY_MS = RECONCILE_EVERY_MS;
/**
 * Time budget of one job. A handler past it is left RUNNING (reclaimStuck requeues it after 10 minutes, as after a crash), is
 * logged, and the lane moves on to the other due jobs instead of waiting on it.
 */
export const JOB_BUDGET_MS = 5 * 60_000;

type State = { timer: ReturnType<typeof setInterval>; busy: boolean; coordBusy?: boolean; startedAt?: number };
type G = typeof globalThis & { __mpScheduler?: State };
const g = globalThis as G;

/**
 * Runs up to `max` due jobs. Each finished job tells the open pages, so refresh progress, results and failures show without a reload.
 * A job past `budgetMs` ends this drain (it keeps running detached and stays visible as RUNNING with a log line).
 */
export async function drainJobs(run: Record<string, Handler> = handlers, notify: (reason: "state") => void = notifyChange, max = 5, budgetMs = JOB_BUDGET_MS): Promise<number> {
  let n = 0;
  for (let i = 0; i < max; i++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const over = new Promise<"over">((res) => {
      timer = setTimeout(() => res("over"), budgetMs);
      timer.unref?.();
    });
    const r = await Promise.race([runOne(db, run), over]).finally(() => clearTimeout(timer));
    if (r === "over") {
      console.error(`job exceeded its ${Math.round(budgetMs / 1000)} s budget; left running, the job lane continues`);
      break;
    }
    if (r === "idle") break;
    n++;
    notify("state");
  }
  return n;
}

/** Keeps `reconcile.all` on the cadence of the given mode: every RECONCILE_EVERY_MS when active, RECONCILE_IDLE_EVERY_MS when idle. */
export async function paceReconcile(mode: "active" | "idle", now: number, startedAt: number) {
  const intervalMs = mode === "active" ? RECONCILE_EVERY_MS : RECONCILE_IDLE_EVERY_MS;
  const floor = startedAt + RECONCILE_START_DELAY_MS;
  await ensureRecurring(db, { type: "reconcile.all", key: "reconcile", intervalMs, firstRunAt: new Date(Math.max(now, floor)) });
  const j = await db.job.findUnique({ where: { dedupeKey: "reconcile" } });
  if (!j || j.status !== "QUEUED") return;
  let target = j.runAt.getTime();
  // Only a run on the regular cadence is moved; a retry back-off or a manual request keeps its own time.
  const gap = j.finishedAt ? target - j.finishedAt.getTime() : -1;
  if (j.finishedAt && (gap === RECONCILE_EVERY_MS || gap === RECONCILE_IDLE_EVERY_MS)) target = j.finishedAt.getTime() + intervalMs;
  if (target < floor) target = floor;
  if (target !== j.runAt.getTime()) await db.job.updateMany({ where: { id: j.id, status: "QUEUED", runAt: j.runAt }, data: { runAt: new Date(target) } });
}

/** Coordination lane: quick work only. It never waits on the job queue. */
export async function coordinate(now = Date.now()): Promise<number> {
  if (isDemo()) return 0;
  // Workspaces reach GitHub only through their own installation. `reconcile.all` is paced (every 15 minutes, no idle mode: nobody's tab
  // decides it) as soon as ANY workspace has a usable connection; its handler fans out per workspace and does nothing for one without.
  const connected = await db.workspaceInstallation.count({ where: { installation: { suspendedAt: null, deletedAt: null } } });
  if (connected > 0) await paceReconcile("active", now, g.__mpScheduler?.startedAt ?? now);
  await ensureRecurring(db, { type: "digest.daily", key: "digest", intervalMs: DIGEST_EVERY_MS });
  await ensureRecurring(db, { type: "ai.autopilot", key: "ai-autopilot", intervalMs: AI_AUTOPILOT_EVERY_MS });
  await ensureRecurring(db, { type: "github.maintenance", key: "github-maintenance", intervalMs: MAINTENANCE_EVERY_MS });
  await reclaimStuck(db);
  return 0;
}

/** Job lane: one drain at a time. Returns false when a drain was already running (that drain, or the next tick, picks the jobs up). */
export async function runJobLane(s: { busy: boolean }, drain: () => Promise<number> = () => drainJobs()): Promise<boolean> {
  if (s.busy) return false;
  s.busy = true;
  try {
    await drain();
  } catch (e) {
    console.error("job run failed", e instanceof Error ? e.message : e);
  } finally {
    s.busy = false;
  }
  return true;
}

/** One scheduler step: starts each lane that is not already running and does not wait for either. The promises are for tests. */
export function step(
  s: { busy: boolean; coordBusy?: boolean },
  lanes: { coordinate: () => Promise<unknown>; drain: () => Promise<number> },
): { coordination?: Promise<void>; jobs?: Promise<boolean> } {
  const out: { coordination?: Promise<void>; jobs?: Promise<boolean> } = {};
  if (!s.coordBusy) {
    s.coordBusy = true;
    out.coordination = lanes
      .coordinate()
      .then(
        () => {},
        (e) => console.error("scheduler tick failed", e instanceof Error ? e.message : e),
      )
      .finally(() => {
        s.coordBusy = false;
      });
  }
  if (!s.busy) out.jobs = runJobLane(s, lanes.drain);
  return out;
}

/**
 * Runs the due jobs now instead of at the next 5 s tick (a webhook-triggered refresh should not wait for it). It shares the job
 * lane's `busy` flag, so it never runs beside another drain: if one is running, that drain (or the next tick) picks the job up.
 * A no-op when the scheduler was not started in this process.
 */
export async function runJobsNow(): Promise<void> {
  const s = g.__mpScheduler;
  if (!s || isDemo()) return;
  await runJobLane(s);
}

/**
 * Graceful stop for the standalone worker: no new ticks, wait (bounded) for the lanes to finish the job they are on.
 */
export async function stopLocalScheduler(waitMs = 30_000): Promise<void> {
  const s = g.__mpScheduler;
  if (s) clearInterval(s.timer);
  const end = Date.now() + waitMs;
  while (s && (s.busy || s.coordBusy) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  g.__mpScheduler = undefined;
}

/** Starts the two lanes. The standalone worker stops them gracefully on SIGINT/SIGTERM (stopLocalScheduler). */
export function startLocalScheduler(intervalMs = 5000) {
  if (g.__mpScheduler) return;
  const state: State = { busy: false, coordBusy: false, startedAt: Date.now(), timer: undefined as unknown as ReturnType<typeof setInterval> };
  state.timer = setInterval(() => void step(state, { coordinate: () => coordinate(), drain: async () => (isDemo() ? 0 : drainJobs()) }), intervalMs);
  state.timer.unref?.();
  g.__mpScheduler = state;
}
