import type { Db } from "@/lib/db";

/** Delivery ids are kept for a week: GitHub lets a person redeliver a recent delivery, and a replay older than that is not a concern. */
export const DELIVERY_RETENTION_MS = 7 * 86_400_000;
export const MAINTENANCE_EVERY_MS = 24 * 3_600_000;

/**
 * Daily housekeeping of the GitHub App tables: delivery ids older than a week (`GithubDelivery`, global) and install / OAuth states past
 * their expiry (`GithubAppState`, ten minutes of life, used or not). Neither holds anything a person still needs.
 */
export async function pruneGithubAppData(db: Db, now = new Date()): Promise<{ deliveries: number; states: number }> {
  const deliveries = (await db.githubDelivery.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } } })).count;
  const states = (await db.githubAppState.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  return { deliveries, states };
}
