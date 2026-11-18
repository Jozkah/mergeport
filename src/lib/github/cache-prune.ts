import type { Db } from "@/lib/db";

/** Retention policy of the persistent ETag cache (PublicCacheEntry). A pruned row only means the next request is a normal 200. */
export const CACHE_MAX_AGE_DAYS = 14;
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Eviction goes below the cap, so a full cache is not pruned again by the very next write. */
export const CACHE_LOW_WATER_BYTES = Math.floor(CACHE_MAX_BYTES * 0.9);
/** Pruning runs at most this often per process, unless a burst of writes outgrows the budget (then still at most every CACHE_PRUNE_FLOOR_MS). */
export const CACHE_PRUNE_INTERVAL_MS = 5 * 60_000;
export const CACHE_PRUNE_FLOOR_MS = 15_000;
export const CACHE_WRITE_BURST_BYTES = 16 * 1024 * 1024;

/** Two statements on the (fetchedAt, bytes) covering index: delete by age, then delete the oldest rows beyond the byte cap. */
export async function pruneHttpCache(db: Db, now = new Date()): Promise<{ aged: number; evicted: number }> {
  const aged = (await db.publicCacheEntry.deleteMany({ where: { fetchedAt: { lt: new Date(now.getTime() - CACHE_MAX_AGE_DAYS * 86_400_000) } } })).count;
  const total = (await db.publicCacheEntry.aggregate({ _sum: { bytes: true } }))._sum.bytes ?? 0;
  if (total <= CACHE_MAX_BYTES) return { aged, evicted: 0 };
  // Newest first, running byte total: everything past the low-water mark is the oldest tail.
  const evicted = await db.$executeRaw`DELETE FROM "PublicCacheEntry" WHERE "key" IN (SELECT "key" FROM (SELECT "key", SUM("bytes") OVER (ORDER BY "fetchedAt" DESC, "key") AS run FROM "PublicCacheEntry") WHERE run > ${CACHE_LOW_WATER_BYTES})`;
  return { aged, evicted };
}

const state = new WeakMap<Db, { last: number; written: number }>();

/** Called after every cache write: cheap bookkeeping, and a prune only when due. Never throws (retention must not fail a request). */
export async function maybePruneHttpCache(db: Db, wroteBytes: number, now = Date.now()): Promise<void> {
  const s = state.get(db) ?? { last: 0, written: 0 };
  state.set(db, s);
  s.written += wroteBytes;
  const since = now - s.last;
  if (since < CACHE_PRUNE_FLOOR_MS || (since < CACHE_PRUNE_INTERVAL_MS && s.written < CACHE_WRITE_BURST_BYTES)) return;
  s.last = now;
  s.written = 0;
  try {
    await pruneHttpCache(db, new Date(now));
  } catch {
    /* best effort; retried at the next interval */
  }
}
