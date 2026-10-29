/** Sync ordering helpers. Pure. */

/**
 * Never let an older delivery overwrite a newer snapshot. GitHub's own `updated_at` is the clock,
 * so webhook and polling writers agree regardless of when each arrived.
 */
export function shouldApplyUpdate(existing: { updatedAtGh: Date } | null, incomingUpdatedAtGh: Date): boolean {
  if (!existing) return true;
  return incomingUpdatedAtGh.getTime() >= existing.updatedAtGh.getTime();
}

export type Backoff = { delayMs: number; giveUp: boolean };

export function backoff(attempts: number, maxAttempts: number, retryAfterSeconds?: number): Backoff {
  if (attempts >= maxAttempts) return { delayMs: 0, giveUp: true };
  if (retryAfterSeconds && retryAfterSeconds > 0) return { delayMs: retryAfterSeconds * 1000, giveUp: false };
  const base = Math.min(15 * 60_000, 5_000 * 2 ** attempts);
  return { delayMs: base, giveUp: false };
}

export type RateLimitInfo = { remaining: number; limit: number; resetAt: Date };

/** Budget-aware refresh: keep a reserve so interactive requests are never starved by background sync. */
export function canSpend(rl: RateLimitInfo | null, cost: number, reserve: number, now = new Date()): boolean {
  if (!rl) return true;
  if (rl.resetAt.getTime() <= now.getTime()) return true;
  return rl.remaining - cost >= reserve;
}
