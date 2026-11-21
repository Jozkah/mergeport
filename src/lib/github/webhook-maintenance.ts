import type { Db } from "@/lib/db";

/** Delivery ids are kept for a week: GitHub lets a person redeliver a recent delivery, and a replay older than that is not a concern. */
export const DELIVERY_RETENTION_MS = 7 * 86_400_000;
export const MAINTENANCE_EVERY_MS = 24 * 3_600_000;

const BATCH = 1000;
const MAX_BATCHES = 50;

/** Runs a `DELETE ... WHERE key IN (SELECT ... LIMIT 1000)` until a batch comes back short, at most 50 times (50,000 rows a pass). */
async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Daily housekeeping of the GitHub App tables, in batches so a large backlog never holds a long lock: delivery ids older than a week
 * (`GithubDelivery`, global), install / OAuth states past their expiry (`GithubAppState`, ten minutes of life, used or not), and expired
 * request counters (`RateLimitState` rows whose window ended; the GitHub budget rows `source` and `installation:<id>` are kept).
 */
export async function pruneGithubAppData(db: Db, now = new Date()): Promise<{ deliveries: number; states: number; counters: number }> {
  const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_MS);
  const deliveries = await inBatches(() => db.$executeRaw`DELETE FROM "GithubDelivery" WHERE "deliveryId" IN (SELECT "deliveryId" FROM "GithubDelivery" WHERE "receivedAt" < ${cutoff} ORDER BY "receivedAt" LIMIT ${BATCH})`);
  const states = (await db.githubAppState.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  const counters = await inBatches(() => db.$executeRaw`DELETE FROM "RateLimitState" WHERE "key" IN (SELECT "key" FROM "RateLimitState" WHERE "resetAt" < ${now} AND "key" <> 'source' AND "key" NOT LIKE 'installation:%' ORDER BY "resetAt" LIMIT ${BATCH})`);
  return { deliveries, states, counters };
}
