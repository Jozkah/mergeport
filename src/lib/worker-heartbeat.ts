import type { Db } from "@/lib/db";

/**
 * Worker liveness for /api/health. The worker (scripts/worker.ts) stamps one RateLimitState row every HEARTBEAT_EVERY_MS; the web
 * process only ever reads its age. No new table: the row's `resetAt` is a week ahead so the daily counter prune (which deletes
 * expired rows) leaves it alone while a worker is alive. Any number of workers share the row; the freshest beat wins.
 */
export const HEARTBEAT_KEY = "worker:heartbeat";
export const HEARTBEAT_EVERY_MS = 15_000;
/** Older than this (four missed beats) reads as stale. */
export const HEARTBEAT_STALE_MS = 60_000;

export type WorkerStatus = "fresh" | "stale" | "unknown";

export async function beat(db: Db, now = new Date()): Promise<void> {
  const until = new Date(now.getTime() + 7 * 24 * 3_600_000);
  await db.$executeRaw`
    INSERT INTO "RateLimitState" ("key", "remaining", "limit", "resetAt", "updatedAt")
    VALUES (${HEARTBEAT_KEY}, ${0}, ${1}, ${until}, ${now})
    ON CONFLICT ("key") DO UPDATE SET "resetAt" = ${until}, "updatedAt" = ${now}
    WHERE "RateLimitState"."updatedAt" < ${now}`;
}

/** `unknown`: no heartbeat was ever recorded (or it was pruned after a week of silence), or it could not be read. */
export async function workerStatus(db: Db, now = new Date()): Promise<WorkerStatus> {
  try {
    const row = await db.rateLimitState.findUnique({ where: { key: HEARTBEAT_KEY }, select: { updatedAt: true } });
    if (!row) return "unknown";
    return now.getTime() - row.updatedAt.getTime() <= HEARTBEAT_STALE_MS ? "fresh" : "stale";
  } catch {
    return "unknown";
  }
}
