import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { GhAbortedError, GhTimeoutError, IdentityError } from "@/lib/github/exec";
import { GithubError } from "@/lib/github/port";

/**
 * Network discovery that never blocks a page.
 *
 * Pages read the LAST KNOWN result from the local database and show how old it is. Refreshing happens in the background,
 * through `refreshInBackground`, which:
 *   - runs at most one refresh per key at a time (concurrent callers share it);
 *   - gives every attempt a deadline and an AbortSignal (cancelling the underlying `gh` process tree);
 *   - retries a bounded number of times with backoff, then leaves the next attempt to the scheduler;
 *   - NEVER replaces a good result with an empty one: a failure keeps the old payload and records WHY (offline,
 *     rate limited, sign-in needed) so the page can say so;
 *   - can be cancelled as a whole at shutdown, and any attempt a crash interrupted is marked on the next start.
 */

export type DiscoveryState = "EMPTY" | "FRESH" | "RETRYING" | "OFFLINE" | "AUTH" | "RATE_LIMITED" | "ERROR";

export type CachedView<T> = {
  payload: T | null;
  fetchedAt: Date | null;
  state: DiscoveryState;
  error: string | null;
  attempts: number;
  nextRetryAt: Date | null;
  /** Older than `staleAfterMs`, or never fetched. */
  stale: boolean;
};

export const STALE_AFTER_MS = 5 * 60_000;
export const ATTEMPT_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [2_000, 8_000];
export const RETRY_LATER_MS = 2 * 60_000;

// BigInt-safe JSON: payloads (repository metadata) carry GitHub ids as bigint.
const BIG = "$big";
export const toJson = <T>(v: T): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { [BIG]: x.toString() } : x))) as Prisma.InputJsonValue;
export const fromJson = <T>(v: unknown): T =>
  JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && BIG in x ? BigInt((x as Record<string, string>)[BIG]) : x)) as T;

export async function readCached<T>(db: Db, key: string, now = new Date(), staleAfterMs = STALE_AFTER_MS): Promise<CachedView<T>> {
  const row = await db.discoveryCache.findUnique({ where: { key } });
  if (!row) return { payload: null, fetchedAt: null, state: "EMPTY", error: null, attempts: 0, nextRetryAt: null, stale: true };
  return {
    payload: row.payload === null ? null : fromJson<T>(row.payload),
    fetchedAt: row.fetchedAt,
    state: row.state as DiscoveryState,
    error: row.error,
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt,
    stale: !row.fetchedAt || now.getTime() - row.fetchedAt.getTime() > staleAfterMs,
  };
}

type Registry = { inflight: Map<string, Promise<void>>; controllers: Set<AbortController> };
const registries = new WeakMap<Db, Registry>();
const registry = (db: Db): Registry => {
  let r = registries.get(db);
  if (!r) registries.set(db, (r = { inflight: new Map(), controllers: new Set() }));
  return r;
};

export const isRefreshing = (db: Db, key: string) => registry(db).inflight.has(key);

type Classified = { state: DiscoveryState; message: string; retry: boolean; until?: Date };
export function classify(e: unknown, now: Date): Classified {
  if (e instanceof IdentityError) return { state: "AUTH", message: e.message, retry: false };
  if (e instanceof GithubError) {
    if (e.kind === "auth") return { state: "AUTH", message: e.message, retry: false };
    if (e.kind === "rate-limited") return { state: "RATE_LIMITED", message: "GitHub's rate limit was reached. The saved list is shown until it resets.", retry: false, until: e.resetAt ?? new Date(now.getTime() + (e.retryAfterSeconds ?? 60) * 1000) };
    if (e.kind === "network") return { state: "OFFLINE", message: "GitHub could not be reached.", retry: true };
    return { state: "ERROR", message: e.message, retry: false };
  }
  if (e instanceof GhTimeoutError || (e instanceof Error && e.name === "TimeoutError")) return { state: "OFFLINE", message: "GitHub did not answer in time.", retry: true };
  // Only the transport's own failure counts as "offline". Any other TypeError is a bug of ours and must not pose as a network problem.
  if (e instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e.message)) return { state: "OFFLINE", message: "GitHub could not be reached.", retry: true };
  if (e instanceof GhAbortedError || (e instanceof Error && e.name === "AbortError")) return { state: "OFFLINE", message: "Interrupted.", retry: false };
  return { state: "ERROR", message: e instanceof Error ? e.message : "Unexpected error", retry: false };
}

export type RefreshOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onChange?: () => void;
};

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Starts (or joins) a background refresh of `key`. The returned promise settles when it is finished; callers normally ignore it. */
export function refreshInBackground<T>(db: Db, key: string, load: (signal: AbortSignal) => Promise<T>, o: RefreshOptions = {}): Promise<void> {
  const reg = registry(db);
  const existing = reg.inflight.get(key);
  if (existing) return existing;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? abortableSleep;
  const attemptsMax = o.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = o.backoffMs ?? BACKOFF_MS;
  const ac = new AbortController();
  reg.controllers.add(ac);

  const write = async (data: { state: DiscoveryState; error?: string | null; attempts: number; nextRetryAt?: Date | null; payload?: Prisma.InputJsonValue; fetchedAt?: Date }) => {
    const base = { state: data.state, error: data.error ?? null, attempts: data.attempts, nextRetryAt: data.nextRetryAt ?? null };
    const withPayload = data.payload !== undefined ? { ...base, payload: data.payload, fetchedAt: data.fetchedAt ?? now() } : base;
    await db.discoveryCache.upsert({ where: { key }, create: { key, ...withPayload }, update: withPayload });
    o.onChange?.();
  };

  const job = (async () => {
    let attempt = 0;
    for (;;) {
      attempt++;
      if (ac.signal.aborted) return;
      await write({ state: "RETRYING", attempts: attempt });
      try {
        const attemptSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(o.timeoutMs ?? ATTEMPT_TIMEOUT_MS)]);
        const result = await load(attemptSignal);
        await write({ state: "FRESH", attempts: 0, payload: toJson(result), fetchedAt: now() });
        return;
      } catch (e) {
        if (ac.signal.aborted) {
          await write({ state: "OFFLINE", error: "Interrupted before it finished.", attempts: attempt, nextRetryAt: new Date(now().getTime() + RETRY_LATER_MS) }).catch(() => {});
          return;
        }
        const c = classify(e, now());
        const last = !c.retry || attempt >= attemptsMax;
        if (last) {
          await write({ state: c.state, error: c.message, attempts: attempt, nextRetryAt: c.until ?? (c.state === "AUTH" ? null : new Date(now().getTime() + RETRY_LATER_MS)) });
          return;
        }
        await write({ state: "OFFLINE", error: c.message, attempts: attempt, nextRetryAt: new Date(now().getTime() + (backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 8_000)) });
        await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 8_000, ac.signal);
      }
    }
  })().finally(() => {
    reg.inflight.delete(key);
    reg.controllers.delete(ac);
  });
  reg.inflight.set(key, job);
  return job;
}

/** Cancels every refresh in flight for this database (shutdown, or the profile being closed). Their `gh` processes are killed with them. */
export function cancelAllDiscovery(db: Db): void {
  for (const c of registry(db).controllers) c.abort();
}

/** After a crash or kill, an attempt that was RETRYING can never finish: say so instead of showing "retrying" for ever. */
export async function recoverInterrupted(db: Db, now = new Date()): Promise<number> {
  const r = await db.discoveryCache.updateMany({ where: { state: "RETRYING" }, data: { state: "OFFLINE", error: "Interrupted before it finished.", nextRetryAt: now } });
  return r.count;
}

/**
 * Lists stuck on "sign-in needed". They never retry on a timer (that would hammer a token that really is rejected), but once
 * the account verifies again they must not keep showing the old error: the scheduler re-asks them once, at most per minute.
 */
export async function authKeysToRecheck(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db.discoveryCache.findMany({ where: { state: "AUTH", updatedAt: { lte: new Date(now.getTime() - 60_000) } }, select: { key: true } });
  return rows.map((r) => r.key).filter((k) => !isRefreshing(db, k));
}

/** Keys whose retry time has come (offline, errors; rate limits wait for their reset). Used by the scheduler. */
export async function dueKeys(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db.discoveryCache.findMany({ where: { state: { in: ["OFFLINE", "ERROR", "RATE_LIMITED"] }, nextRetryAt: { lte: now } }, select: { key: true } });
  return rows.map((r) => r.key).filter((k) => !isRefreshing(db, k));
}
