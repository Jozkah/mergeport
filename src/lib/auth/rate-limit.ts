import type { Db } from "@/lib/db";

/**
 * Fixed-window counter in the database (RateLimitState), so it holds across processes and restarts. One statement does the
 * check and the count, so two concurrent requests cannot both read "4 of 5". Keys are prefixed `auth:` and carry hashes, not
 * addresses. Returns true when the call is within the limit.
 */
export async function hit(db: Db, key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  const resetAt = new Date(now.getTime() + windowMs);
  const rows = await db.$queryRaw<{ remaining: number }[]>`
    INSERT INTO "RateLimitState" ("key", "remaining", "limit", "resetAt", "updatedAt")
    VALUES (${key}, ${max - 1}, ${max}, ${resetAt}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "remaining" = CASE WHEN "RateLimitState"."resetAt" <= ${now} THEN ${max - 1} ELSE "RateLimitState"."remaining" - 1 END,
      "resetAt" = CASE WHEN "RateLimitState"."resetAt" <= ${now} THEN ${resetAt} ELSE "RateLimitState"."resetAt" END,
      "limit" = ${max},
      "updatedAt" = ${now}
    RETURNING "remaining"`;
  return (rows[0]?.remaining ?? -1) >= 0;
}
