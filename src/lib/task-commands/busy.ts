/**
 * The command line shares the database with the running app. Retries cover Postgres serialization failure / deadlock (40001, 40P01, P2034)
 * and dropped or refused connections (a restarting server), plus the old SQLite busy codes (harmless on Postgres).
 */
const BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|P1008|Socket timeout|\b40001\b|\b40P01\b|deadlock detected|could not serialize|ECONNRESET|ECONNREFUSED|Connection terminated|connection timeout|P1001|P1017|P2034/i;

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
