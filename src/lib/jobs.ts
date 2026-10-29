import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { backoff } from "@/lib/domain/sync";
import { GithubError } from "@/lib/github/port";

/**
 * Local persistent job queue (SQLite). Lifecycle rules, all covered by tests/scheduler.test.ts:
 *
 *  - RECURRENCE is owned by the runner, never by the handler. A recurring job (intervalMs) goes back to QUEUED with
 *    runAt = finish time + interval after every run, successful or not. A handler must not enqueue its own successor:
 *    the earlier design did that under the same dedupe key while the job was RUNNING, the enqueue was swallowed as a
 *    duplicate, and the runner then marked the job DONE, so the schedule silently ended after one cycle.
 *  - A trigger that arrives for a job that is RUNNING sets `dirty`; the job runs again right after it finishes, so
 *    nothing is lost and nothing runs concurrently.
 *  - After the app was closed, a due job runs ONCE on resume (no catch-up storm) and the next run is a full interval later.
 *  - Jobs left RUNNING by a crashed process are reclaimed.
 */

export type JobRow = { id: string; type: string; payload: unknown; attempts: number; maxAttempts: number; intervalMs: number | null; dirty: boolean };

export type EnqueueInput = { type: string; payload: Prisma.InputJsonValue; dedupeKey?: string; runAt?: Date; maxAttempts?: number; intervalMs?: number };

export async function enqueue(db: Db, job: EnqueueInput) {
  const runAt = job.runAt ?? new Date();
  const maxAttempts = job.maxAttempts ?? 5;
  if (!job.dedupeKey) return db.job.create({ data: { type: job.type, payload: job.payload, runAt, maxAttempts, intervalMs: job.intervalMs } });
  // The row can change state between the read and the write (a running job finishing, a queued one being claimed), so each write
  // names the state it was decided from, and a lost race simply decides again from the new state.
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.job.findUnique({ where: { dedupeKey: job.dedupeKey } });
    if (!existing) {
      try {
        return await db.job.create({ data: { type: job.type, payload: job.payload, dedupeKey: job.dedupeKey, runAt, maxAttempts, intervalMs: job.intervalMs } });
      } catch {
        continue; // another caller created it first
      }
    }
    // A request for a complete (full) run is never downgraded by a later, lighter request that merges into the same job.
    const keepFull = (existing.payload as { full?: boolean } | null)?.full === true && (job.payload as { full?: boolean } | null)?.full !== true;
    const payload = keepFull ? ({ ...(job.payload as object), full: true } as Prisma.InputJsonValue) : job.payload;
    const where = { id: existing.id, status: existing.status };
    const res =
      existing.status === "RUNNING"
        ? await db.job.updateMany({ where, data: { dirty: true, payload } }) // run again after this run
        : existing.status === "QUEUED"
          ? await db.job.updateMany({ where, data: { payload, runAt: runAt < existing.runAt ? runAt : existing.runAt } })
          : await db.job.updateMany({ where, data: { status: "QUEUED", payload: job.payload, runAt, attempts: 0, lastError: null, lockedAt: null, finishedAt: null, dirty: false } });
    if (res.count === 1) return db.job.findUniqueOrThrow({ where: { id: existing.id } });
  }
  throw new Error("Could not queue the job: it kept changing state");
}

/** Idempotent: call on every start. Never resets a pending run time or duplicates the job. */
export async function ensureRecurring(db: Db, job: { type: string; key: string; intervalMs: number; payload?: Prisma.InputJsonValue; firstRunAt?: Date }) {
  const existing = await db.job.findUnique({ where: { dedupeKey: job.key } });
  if (!existing) return db.job.create({ data: { type: job.type, dedupeKey: job.key, payload: job.payload ?? {}, intervalMs: job.intervalMs, runAt: job.firstRunAt ?? new Date(), maxAttempts: 3 } });
  const revive = existing.status === "FAILED" || existing.status === "DONE";
  return db.job.update({ where: { id: existing.id }, data: { intervalMs: job.intervalMs, payload: job.payload ?? existing.payload ?? {}, ...(revive ? { status: "QUEUED", runAt: job.firstRunAt ?? new Date(), attempts: 0, lastError: null, finishedAt: null } : {}) } });
}

export async function claim(db: Db, now = new Date()): Promise<JobRow | null> {
  for (let i = 0; i < 50; i++) {
    const candidate = await db.job.findFirst({ where: { status: "QUEUED", runAt: { lte: now } }, orderBy: { runAt: "asc" } });
    if (!candidate) return null;
    // Atomic claim: only one caller can flip QUEUED -> RUNNING, even across processes sharing the file.
    const won = await db.job.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "RUNNING", lockedAt: now, attempts: { increment: 1 } } });
    if (won.count === 1) {
      const j = await db.job.findUniqueOrThrow({ where: { id: candidate.id } });
      return { id: j.id, type: j.type, payload: j.payload, attempts: j.attempts, maxAttempts: j.maxAttempts, intervalMs: j.intervalMs, dirty: j.dirty };
    }
  }
  return null;
}

/** Jobs whose process died stay RUNNING forever unless reclaimed. */
export async function reclaimStuck(db: Db, olderThanMs = 10 * 60_000, now = new Date()) {
  const r = await db.job.updateMany({ where: { status: "RUNNING", lockedAt: { lt: new Date(now.getTime() - olderThanMs) } }, data: { status: "QUEUED", lockedAt: null } });
  return r.count;
}

export type Handler = (payload: never, job: JobRow) => Promise<void>;
export type RunResult = "idle" | "done" | "requeued" | "retry" | "failed";

export async function runOne(db: Db, handlers: Record<string, Handler>, now = new Date(), clock: () => Date = () => now): Promise<RunResult> {
  const job = await claim(db, now);
  if (!job) return "idle";
  const h = handlers[job.type];
  try {
    if (!h) throw new Error(`No handler for ${job.type}`);
    await h(job.payload as never, job);
    return finish(db, job, clock(), null);
  } catch (e) {
    const retryAfter = e instanceof GithubError ? e.retryAfterSeconds : undefined;
    const permanent = e instanceof GithubError && (e.kind === "not-found" || e.kind === "forbidden" || e.kind === "auth" || e.kind === "sso");
    const msg = e instanceof Error ? e.message : String(e);
    const b = backoff(job.attempts, job.maxAttempts, retryAfter);
    if (!permanent && !b.giveUp) {
      await db.job.update({ where: { id: job.id }, data: { status: "QUEUED", lastError: msg, lockedAt: null, runAt: new Date(clock().getTime() + b.delayMs) } });
      return "retry";
    }
    return finish(db, job, clock(), msg);
  }
}

async function finish(db: Db, job: JobRow, at: Date, error: string | null): Promise<RunResult> {
  // `dirty` can be set at any moment while the handler runs, including between a read and the final write. So every terminal
  // write is conditional on `dirty` still being false, and a lost race falls through to the requeue below instead of finishing.
  const terminal: Prisma.JobUpdateManyMutationInput = job.intervalMs
    ? { status: "QUEUED", runAt: new Date(at.getTime() + job.intervalMs), attempts: 0, lockedAt: null, lastError: error, finishedAt: at } // a failure never ends the recurrence
    : error
      ? { status: "FAILED", lastError: error, finishedAt: at, lockedAt: null }
      : { status: "DONE", finishedAt: at, lockedAt: null, lastError: null };
  const done = await db.job.updateMany({ where: { id: job.id, dirty: false }, data: terminal });
  if (done.count === 1) return job.intervalMs ? "requeued" : error ? "failed" : "done";
  await db.job.updateMany({ where: { id: job.id, dirty: true }, data: { status: "QUEUED", dirty: false, runAt: at, attempts: 0, lockedAt: null, lastError: error } });
  return "requeued";
}
