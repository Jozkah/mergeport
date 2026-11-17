/**
 * The command line shares the profile's SQLite file with the running app. The driver already waits up to 10 s for a lock; this adds a
 * few spaced retries on top of that for the rare case where the app holds the write lock for longer (a big sync commit).
 */
const BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|P1008|Socket timeout/i;

export const isBusy = (e: unknown): boolean => BUSY.test(e instanceof Error ? `${e.message} ${String((e as { code?: unknown }).code ?? "")}` : String(e));

export type RetryOpts = { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };

/** Runs `fn`, retrying only when SQLite reports the database as busy. Any other error is thrown at once. */
export async function withBusyRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 4);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !isBusy(e)) throw e;
      await sleep((opts.delayMs ?? 250) * attempt);
    }
  }
}
