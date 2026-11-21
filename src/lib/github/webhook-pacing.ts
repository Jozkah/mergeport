import type { Db } from "@/lib/db";
import { enqueue } from "@/lib/jobs";

/** An installation that got a webhook this recently is "live": its repositories reconcile less often, because events keep them current. */
export const LIVE_WINDOW_MS = 24 * 3_600_000;
/** How often a live installation's repository is reconciled (the safety net for a missed delivery). Others reconcile on every 15-minute run. */
export const LIVE_RECONCILE_MS = 60 * 60_000;
/** The reconcile run is every 15 minutes and finishes a little late, so "an hour" means "at least 55 minutes since the last sync". */
export const LIVE_RECONCILE_SLACK_MS = 5 * 60_000;

/**
 * Queues the reconcile of one hosted workspace's repositories that an installation serves. A repository whose installation received a
 * webhook within 24 hours, that synced cleanly within the last hour, is skipped this round; anything else (never synced, last sync
 * failed, rate limited, not ACTIVE, or its installation silent for a day) is queued as before, so the safety net never goes away.
 */
export async function enqueueHostedReconcile(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const served = await db.repository.findMany({
    where: { workspaceId, trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false, installationId: { not: null } },
    select: { id: true, installationId: true, trackingStatus: true, lastSyncedAt: true, syncError: true, rateLimited: true },
  });
  const rows = await db.githubInstallation.findMany({ where: { workspaces: { some: { workspaceId } } }, select: { installationId: true, lastWebhookAt: true } });
  const live = new Map(rows.map((r) => [String(r.installationId), r.lastWebhookAt !== null && now.getTime() - r.lastWebhookAt.getTime() < LIVE_WINDOW_MS]));
  let queued = 0;
  for (const r of served) {
    const healthy = r.trackingStatus === "ACTIVE" && !r.syncError && !r.rateLimited && r.lastSyncedAt !== null;
    if (healthy && live.get(String(r.installationId)) && now.getTime() - r.lastSyncedAt!.getTime() < LIVE_RECONCILE_MS - LIVE_RECONCILE_SLACK_MS) continue;
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: `sync:${r.id}`, workspaceId });
    queued++;
  }
  return queued;
}
