import { db } from "@/lib/db";
import { canSpend } from "@/lib/domain/sync";
import { portForSync } from "@/lib/github/factory";
import { GithubError } from "@/lib/github/port";
import type { Handler } from "@/lib/jobs";
import { maybeRequestUpdate, updateHandlers } from "@/lib/local/upstream-updater-job";
import { RELEASES_JOB, maybeRequestReleaseCheck, runReleaseCheck } from "@/lib/services/upstream-releases";
import { setStatus, syncFork, syncItem, syncRepository } from "@/lib/sync/repository";

/**
 * Jobs for SOURCE repositories (issues, PRs, comments, reviews, branches), fetched with the signed-in person's own
 * access. Their rate-limit budget ("source") is tracked separately from coordination-space sync, so a burst of source
 * refreshes can never starve shared-state sync, and vice versa.
 */

export const SOURCE_BUDGET_KEY = "source";
export const RECONCILE_EVERY_MS = 15 * 60_000;
export const DIGEST_EVERY_MS = 10 * 60_000;

export async function guardSourceBudget() {
  const rl = await db.rateLimitState.findUnique({ where: { key: SOURCE_BUDGET_KEY } });
  const state = rl ? { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt } : null;
  if (!canSpend(state, 10, 25)) {
    const secs = Math.max(30, Math.ceil((state!.resetAt.getTime() - Date.now()) / 1000));
    throw new GithubError("rate-limited", "Waiting for the GitHub API budget to reset", secs, state!.resetAt);
  }
}

async function recordRate(rate: { remaining: number; limit: number; resetAt: Date } | null) {
  if (!rate) return;
  await db.rateLimitState.upsert({ where: { key: SOURCE_BUDGET_KEY }, create: { key: SOURCE_BUDGET_KEY, ...rate }, update: { ...rate } });
}

export const handlers: Record<string, Handler> = {
  "sync.repository": (async (p: { repositoryId: string; full?: boolean }) => {
    await guardSourceBudget();
    const port = await portForSync(db, p.repositoryId);
    if (!port) return;
    try {
      await syncRepository(db, port, p.repositoryId, { full: p.full });
    } finally {
      await recordRate(port.lastRate());
    }
    // The data of this repository changed: redraw the open pages (also right for the Refresh button).
    (await import("@/lib/local/runtime")).notifyChange("pulled");
    const maps = await db.forkMapping.findMany({ where: { OR: [{ forkRepoId: p.repositoryId }, { upstreamRepoId: p.repositoryId }] }, select: { id: true } });
    const { enqueue } = await import("@/lib/jobs");
    for (const m of maps) await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
  }) as Handler,
  "sync.item": (async (p: { repositoryId: string; number: number }) => {
    await guardSourceBudget();
    const port = await portForSync(db, p.repositoryId);
    if (port) await syncItem(db, port, p.repositoryId, p.number);
  }) as Handler,
  "sync.fork": (async (p: { mappingId: string }) => {
    const m = await db.forkMapping.findUnique({ where: { id: p.mappingId } });
    if (!m) return;
    await guardSourceBudget();
    const port = await portForSync(db, m.forkRepoId);
    if (port) {
      try {
        await syncFork(db, port, p.mappingId); // a rate limit is rethrown here, so the job backs off until the reset
      } finally {
        await recordRate(port.lastRate());
      }
    }
    await maybeRequestUpdate(db, p.mappingId); // opt-in upstream auto-update, when the fork is now known to be behind
    await maybeRequestReleaseCheck(db, p.mappingId); // opt-in release watch (its own 15-minute cap), whether or not the fork is behind
  }) as Handler,
  ...updateHandlers(db),
  // Release watch: reads the upstream's releases through the GitHub API only (no clone, no git, no command), within the same rate-limit budget.
  [RELEASES_JOB]: (async (p: { mappingId: string; manual?: boolean }) => {
    const m = await db.forkMapping.findUnique({ where: { id: p.mappingId } });
    if (!m) return;
    await guardSourceBudget();
    const port = await portForSync(db, m.forkRepoId);
    if (!port) return;
    try {
      await runReleaseCheck(db, port, p.mappingId, { manual: p.manual === true });
    } finally {
      await recordRate(port.lastRate());
      (await import("@/lib/local/runtime")).notifyChange("state"); // redraw open pages: the history may have changed
    }
  }) as Handler,
  // Recurrence is owned by the runner (ensureRecurring), never by this handler.
  "reconcile.all": (async () => {
    const { enqueue } = await import("@/lib/jobs");
    const repos = await db.repository.findMany({ where: { trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false }, select: { id: true } });
    for (const r of repos) await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: `sync:${r.id}` });
    // A fork that is NOT behind never reaches an update request, so release watches are asked for here as well (each capped to one check per ~15 minutes).
    const watches = await db.upstreamUpdateConfig.findMany({ where: { enabled: true, mode: "releases" }, select: { mappingId: true } });
    for (const w of watches) await maybeRequestReleaseCheck(db, w.mappingId);
  }) as Handler,
  // Local only (no GitHub, no network): makes the daily digest once per local day, and catches up after the app was closed.
  "digest.daily": (async () => {
    const { runDailyDigest } = await import("@/lib/services/digest");
    if ((await runDailyDigest(db)) === "generated") (await import("@/lib/local/runtime")).notifyChange("state");
  }) as Handler,
};

export { setStatus };
