import type { Db } from "@/lib/db";

/**
 * Counters in the database (RateLimitState), so limits hold across processes and restarts. Keys are prefixed `auth:` and carry
 * hashes, not addresses. Each function is ONE statement, so concurrent requests cannot both read "4 of 5".
 */

/**
 * Fixed-window counter. Returns true and counts one use when the key is within `max` for the window. A refused call is NOT counted
 * (the statement updates nothing), so hammering a full bucket neither extends it nor costs anyone else anything.
 */
export async function take(db: Db, key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  const resetAt = new Date(now.getTime() + windowMs);
  const rows = await db.$queryRaw<{ remaining: number }[]>`
    INSERT INTO "RateLimitState" ("key", "remaining", "limit", "resetAt", "updatedAt")
    VALUES (${key}, ${max - 1}, ${max}, ${resetAt}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "remaining" = CASE WHEN "RateLimitState"."resetAt" <= ${now} THEN ${max - 1} ELSE "RateLimitState"."remaining" - 1 END,
      "resetAt" = CASE WHEN "RateLimitState"."resetAt" <= ${now} THEN ${resetAt} ELSE "RateLimitState"."resetAt" END,
      "limit" = ${max},
      "updatedAt" = ${now}
    WHERE "RateLimitState"."resetAt" <= ${now} OR "RateLimitState"."remaining" > 0
    RETURNING "remaining"`;
  return rows.length === 1;
}

/**
 * Minimum spacing: true (and the slot is taken for `gapMs`) only when the key is not inside an earlier slot. A refused call does not
 * move the slot, so the next call is allowed exactly `gapMs` after the last one that WENT THROUGH, however many were refused between.
 */
export async function claimGap(db: Db, key: string, gapMs: number, now = new Date()): Promise<boolean> {
  const until = new Date(now.getTime() + gapMs);
  const rows = await db.$queryRaw<{ key: string }[]>`
    INSERT INTO "RateLimitState" ("key", "remaining", "limit", "resetAt", "updatedAt")
    VALUES (${key}, ${0}, ${1}, ${until}, ${now})
    ON CONFLICT ("key") DO UPDATE SET "resetAt" = ${until}, "updatedAt" = ${now}
    WHERE "RateLimitState"."resetAt" <= ${now}
    RETURNING "key"`;
  return rows.length === 1;
}
