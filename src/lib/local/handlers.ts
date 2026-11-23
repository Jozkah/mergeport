import { db } from "@/lib/db";
import { ACCESS_JOB, REFRESH_AFTER_MS, requestAccessRefresh } from "@/lib/github/access-cache";
import { githubAppConfig } from "@/lib/github/app-config";
import { refreshUserAccess } from "@/lib/github/user-access";
import * as budget from "@/lib/github/budget";
import { SOURCE_BUDGET_KEY } from "@/lib/github/budget";
import { portForSync } from "@/lib/github/factory";
import { GithubNotConnectedError } from "@/lib/github/hosted";
import { workspaceGithubStatus } from "@/lib/github/status";
import { checkInstallationFromGithub } from "@/lib/github/installation-check";
import { pruneGithubAppData } from "@/lib/github/webhook-maintenance";
import { enqueueHostedReconcile } from "@/lib/github/webhook-pacing";
import type { Handler, JobRow } from "@/lib/jobs";
import { UPDATE_JOB, maybeRequestUpdate, updateHandlers } from "@/lib/local/upstream-updater-job";
import { isHosted } from "@/lib/public-url";
import { RELEASES_JOB, maybeRequestReleaseCheck, runReleaseCheck } from "@/lib/services/upstream-releases";
import { setStatus, syncFork, syncItem, syncRepository } from "@/lib/sync/repository";

/**
 * Jobs for SOURCE repositories (issues, PRs, comments, reviews, branches), fetched with the signed-in person's own
 * access. Their rate-limit budget ("source") is tracked separately from coordination-space sync, so a burst of source
 * refreshes can never starve shared-state sync, and vice versa.
 */

export const RECONCILE_EVERY_MS = 15 * 60_000;
export const DIGEST_EVERY_MS = 10 * 60_000;
export const AI_AUTOPILOT_EVERY_MS = 30 * 60_000;

export { SOURCE_BUDGET_KEY };
export const sourceBudgetKeyFor = (repositoryId: string) => budget.sourceBudgetKeyFor(db, repositoryId);
export const guardSourceBudget = (key: string = SOURCE_BUDGET_KEY) => budget.guardSourceBudget(db, key);
const recordRate = (rate: { remaining: number; limit: number; resetAt: Date } | null, key: string = SOURCE_BUDGET_KEY) => budget.recordRate(db, rate, key);

/**
 * Runs `fn` once per workspace, in a fixed order (id), so one failing tenant cannot starve the ones after it. Each failure is logged
 * and the loop goes on; the job only fails (and retries) when EVERY workspace failed.
 */
export async function forEachWorkspace(d: typeof db, label: string, fn: (workspaceId: string) => Promise<void>): Promise<void> {
  const all = await d.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const errors: unknown[] = [];
  for (const ws of all) {
    try {
      await fn(ws.id);
    } catch (e) {
      errors.push(e);
      console.error(`${label} failed for workspace ${ws.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (all.length > 0 && errors.length === all.length) throw errors[0];
}

const rawHandlers: Record<string, Handler> = {
  "sync.repository": (async (p: { repositoryId: string; full?: boolean }, job: JobRow) => {
    const budget = await sourceBudgetKeyFor(p.repositoryId);
    await guardSourceBudget(budget);
    const port = await portForSync(db, p.repositoryId);
    if (!port) return;
    try {
      await syncRepository(db, port, p.repositoryId, { full: p.full });
    } finally {
      await recordRate(port.lastRate(), budget);
    }
    // The data of this repository changed: redraw the open pages (also right for the Refresh button).
    (await import("@/lib/local/runtime")).notifyChange("pulled");
    const maps = await db.forkMapping.findMany({ where: { OR: [{ forkRepoId: p.repositoryId }, { upstreamRepoId: p.repositoryId }] }, select: { id: true } });
    const { enqueue } = await import("@/lib/jobs");
    for (const m of maps) await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}`, workspaceId: job.workspaceId });
  }) as Handler,
  "sync.item": (async (p: { repositoryId: string; number: number }) => {
    const budget = await sourceBudgetKeyFor(p.repositoryId);
    await guardSourceBudget(budget);
    const port = await portForSync(db, p.repositoryId);
    if (port) {
      try {
        await syncItem(db, port, p.repositoryId, p.number);
      } finally {
        await recordRate(port.lastRate(), budget);
      }
    }
  }) as Handler,
  "sync.fork": (async (p: { mappingId: string }) => {
    const m = await db.forkMapping.findUnique({ where: { id: p.mappingId } });
    if (!m) return;
    const budget = await sourceBudgetKeyFor(m.forkRepoId);
    await guardSourceBudget(budget);
    const port = await portForSync(db, m.forkRepoId);
    if (port) {
      try {
        await syncFork(db, port, p.mappingId); // a rate limit is rethrown here, so the job backs off until the reset
      } finally {
        await recordRate(port.lastRate(), budget);
      }
    }
    if (isHosted()) return; // the auto-update (clone and push) and the release watch stay off for hosted workspaces
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
  // A system-wide job (no workspace): it fans out over the workspaces and everything it queues belongs to exactly one of them.
  "reconcile.all": (async () => {
    const { enqueue } = await import("@/lib/jobs");
    await forEachWorkspace(db, "reconcile.all", async (workspaceId) => {
      if (isHosted()) {
        // Only workspaces with a usable GitHub connection, and only repositories served by an installation. Others have nothing to reconcile.
        if (!(await workspaceGithubStatus(db, workspaceId)).bound) return;
        // An installation that sends webhooks reconciles hourly instead (webhook-pacing.ts); anything unhealthy or silent still runs every time.
        await enqueueHostedReconcile(db, workspaceId);
        return;
      }
      const repos = await db.repository.findMany({ where: { workspaceId, trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false }, select: { id: true } });
      for (const r of repos) await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: `sync:${r.id}`, workspaceId });
      // A fork that is NOT behind never reaches an update request, so release watches are asked for here as well (each capped to one check per ~15 minutes).
      const watches = await db.upstreamUpdateConfig.findMany({ where: { enabled: true, mode: "releases", mapping: { fork: { workspaceId } } }, select: { mappingId: true } });
      for (const w of watches) await maybeRequestReleaseCheck(db, w.mappingId);
    });
    if (isHosted()) {
      // The reconcile pacing also renews what GitHub says each linked person may open (their data is older than REFRESH_AFTER). One job per
      // person (deduplicated), oldest first, capped; page loads trigger the same job for people who are active right now.
      const stale = await db.githubUserToken.findMany({
        where: { status: "OK", OR: [{ accessCheckedAt: null }, { accessCheckedAt: { lt: new Date(Date.now() - REFRESH_AFTER_MS) } }], user: { members: { some: { status: "ACTIVE" } } } },
        select: { userId: true },
        orderBy: { accessCheckedAt: { sort: "asc", nulls: "first" } },
        take: 200,
      });
      for (const s of stale) await requestAccessRefresh(db, s.userId);
    }
  }) as Handler,
  // Hosted only: asks GitHub, with THIS person's own token, which repositories they can open (one job per person, payload { userId }).
  // It serves no single workspace (a person may belong to several), so its job row carries none. A failure to reach GitHub throws, so the job backs off.
  [ACCESS_JOB]: (async (p: { userId: string }) => {
    if (!isHosted() || typeof p?.userId !== "string") return;
    const config = githubAppConfig();
    if (!config) return;
    const r = await refreshUserAccess(db, config, p.userId);
    if (r === "ok" || r === "partial") (await import("@/lib/local/runtime")).notifyChange("state");
  }) as Handler,
  // Hosted: GitHub told us something happened to an installation (webhook); ask GitHub what is true now and record that. A system job per installation.
  "github.installation.check": (async (p: { installationId: string }) => {
    if (!/^\d{1,19}$/.test(String(p?.installationId))) return;
    await checkInstallationFromGithub(db, BigInt(p.installationId));
  }) as Handler,
  // Hosted housekeeping (no GitHub, no network): old webhook delivery ids and expired install states. A system-wide job.
  "github.maintenance": (async () => {
    await pruneGithubAppData(db);
  }) as Handler,
  // Local only (no GitHub, no network): makes the daily digest once per local day, and catches up after the app was closed.
  "digest.daily": (async () => {
    const { runDailyDigest } = await import("@/lib/services/digest");
    await forEachWorkspace(db, "digest.daily", async (workspaceId) => {
      if ((await runDailyDigest(db, workspaceId)) === "generated") (await import("@/lib/local/runtime")).notifyChange("state");
    });
  }) as Handler,
  // Sends to the AI endpoint set in Settings, and only when the autopilot there is on. Writes local tasks and suggestions, never GitHub.
  "ai.autopilot": (async () => {
    const [{ runAutopilot }, { openVault, keyFileFor }, { resolveDbFile }] = await Promise.all([import("@/lib/services/ai-review"), import("@/lib/hub/session-vault"), import("@/lib/db")]);
    await forEachWorkspace(db, "ai.autopilot", async (workspaceId) => {
      if ((await runAutopilot(db, workspaceId, openVault(keyFileFor(resolveDbFile())))) === "done") (await import("@/lib/local/runtime")).notifyChange("state");
    });
  }) as Handler,
};

/**
 * Jobs that reach GitHub. Hosted, there is no server credential to use: the source-sync jobs (sync.repository, sync.item, sync.fork)
 * and reconcile.all run through the repository's own installation (portForSync). A repository without a usable connection has
 * nothing to do, so its job finishes as a no-op (DONE, not failed and retried: a connection that went away is recorded once, and a
 * retry would only repeat it). A rate limit still fails the job so it backs off until the reset. The upstream auto-update (clone and
 * push) and the release watch stay off for hosted workspaces. digest.daily and ai.autopilot never touch GitHub and keep running.
 */
const HOSTED_SOURCE_JOBS = new Set(["sync.repository", "sync.item", "sync.fork", "reconcile.all"]);
const HOSTED_OFF_JOBS = new Set([UPDATE_JOB, RELEASES_JOB]);
const hostedAware = (h: Handler): Handler =>
  (async (...a: Parameters<Handler>) => {
    try {
      return await h(...a);
    } catch (e) {
      if (e instanceof GithubNotConnectedError) return; // no usable connection for this repository: nothing to do, nothing to retry
      throw e;
    }
  }) as Handler;
const skipWhenHosted = (h: Handler): Handler => ((...a: Parameters<Handler>) => (isHosted() ? Promise.resolve() : h(...a))) as Handler;
export const handlers: Record<string, Handler> = Object.fromEntries(
  Object.entries(rawHandlers).map(([k, h]) => [k, HOSTED_OFF_JOBS.has(k) ? skipWhenHosted(h) : HOSTED_SOURCE_JOBS.has(k) ? hostedAware(h) : h]),
);

export { setStatus };
