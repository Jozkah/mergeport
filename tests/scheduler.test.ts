import { beforeEach, describe, expect, it } from "vitest";
import { GithubError } from "@/lib/github/port";
import { enqueue, ensureRecurring, reclaimStuck, runOne, type Handler } from "@/lib/jobs";
import { truncateAll } from "@/lib/demo/seed";
import { drainJobs } from "@/lib/local/scheduler";
import { testDb } from "./helpers";

const db = testDb();
const MIN = 60_000;
const T0 = new Date("2026-10-29T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await truncateAll(db);
});

describe("recurring jobs (regression: schedule ended after one cycle)", () => {
  it("runs three cycles on fake time, one run per interval", async () => {
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: T0 });
    let runs = 0;
    const h = { tick: (async () => void runs++) as Handler };
    expect(await runOne(db, h, T0)).toBe("requeued");
    expect(await runOne(db, h, at(10 * MIN))).toBe("idle"); // not due yet
    expect(await runOne(db, h, at(15 * MIN))).toBe("requeued");
    expect(await runOne(db, h, at(29 * MIN))).toBe("idle");
    expect(await runOne(db, h, at(30 * MIN))).toBe("requeued");
    expect(runs).toBe(3);
    const j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("QUEUED");
    expect(j.runAt).toEqual(at(45 * MIN));
  });

  it("the exact old pattern still recurs: a handler that enqueues its own successor under the same key", async () => {
    // The previous worker did this. The enqueue hit the RUNNING row, was swallowed, and the runner then marked it DONE.
    await ensureRecurring(db, { type: "reconcile", key: "reconcile", intervalMs: 15 * MIN, firstRunAt: T0 });
    let runs = 0;
    const h = {
      reconcile: (async () => {
        runs++;
        await enqueue(db, { type: "reconcile", payload: {}, dedupeKey: "reconcile", runAt: at(15 * MIN) });
      }) as Handler,
    };
    await runOne(db, h, T0);
    expect((await db.job.findFirstOrThrow()).status).toBe("QUEUED"); // was DONE with no next run
    expect(await runOne(db, h, at(0))).toBe("requeued"); // the self-enqueue marked it dirty: one follow-up, never lost
    expect(runs).toBe(2);
    expect((await db.job.findFirstOrThrow()).status).toBe("QUEUED");
    expect(await runOne(db, h, at(16 * MIN))).toBe("requeued");
    expect(runs).toBe(3);
  });

  it("resume after the app was closed for days runs once, then a full interval later (no catch-up storm)", async () => {
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: T0 });
    let runs = 0;
    const h = { tick: (async () => void runs++) as Handler };
    await runOne(db, h, T0);
    const back = at(3 * 24 * 60 * MIN);
    expect(await runOne(db, h, back)).toBe("requeued");
    expect(await runOne(db, h, back)).toBe("idle");
    expect(await runOne(db, h, at(3 * 24 * 60 * MIN + 14 * MIN))).toBe("idle");
    expect(runs).toBe(2);
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(new Date(back.getTime() + 15 * MIN));
  });

  it("crash and restart: a RUNNING job is reclaimed and the recurrence continues", async () => {
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: T0 });
    await db.job.updateMany({ data: { status: "RUNNING", lockedAt: T0, attempts: 1 } }); // process killed mid-run
    let runs = 0;
    const h = { tick: (async () => void runs++) as Handler };
    expect(await runOne(db, h, at(1 * MIN))).toBe("idle"); // stuck RUNNING is invisible to the queue
    expect(await reclaimStuck(db, 10 * MIN, at(20 * MIN))).toBe(1);
    expect(await runOne(db, h, at(20 * MIN))).toBe("requeued");
    expect(await runOne(db, h, at(35 * MIN))).toBe("requeued");
    expect(runs).toBe(2);
  });

  it("duplicate scheduling creates one job and never resets its pending run time", async () => {
    for (let i = 0; i < 5; i++) await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: at(i * MIN) });
    expect(await db.job.count()).toBe(1);
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(T0);
    const h = { tick: (async () => {}) as Handler };
    await runOne(db, h, T0);
    const next = (await db.job.findFirstOrThrow()).runAt;
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN }); // app restarted
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(next);
    expect(await db.job.count()).toBe(1);
  });

  it("concurrent runners never run one due job twice", async () => {
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: T0 });
    let runs = 0;
    const h = {
      tick: (async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 10));
      }) as Handler,
    };
    await Promise.all(Array.from({ length: 8 }, () => runOne(db, h, T0)));
    expect(runs).toBe(1);
  });

  it("failures and exhausted retries never end the recurrence", async () => {
    await ensureRecurring(db, { type: "tick", key: "tick", intervalMs: 15 * MIN, firstRunAt: T0 });
    const bad = {
      tick: (async () => {
        throw new GithubError("forbidden", "no access");
      }) as Handler,
    };
    expect(await runOne(db, bad, T0)).toBe("requeued"); // permanent error: this run is over, the schedule is not
    let j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("QUEUED");
    expect(j.lastError).toMatch(/no access/);
    expect(j.runAt).toEqual(at(15 * MIN));
    const flaky = {
      tick: (async () => {
        throw new GithubError("rate-limited", "slow", 60);
      }) as Handler,
    };
    expect(await runOne(db, flaky, at(15 * MIN))).toBe("retry");
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(at(16 * MIN)); // Retry-After honoured
    for (let i = 0; i < 5; i++) await runOne(db, flaky, at((20 + i * 20) * MIN));
    j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("QUEUED");
  });
});

describe("one-shot jobs", () => {
  it("a trigger during a run is not lost: the job runs again right after, never concurrently", async () => {
    await enqueue(db, { type: "sync", payload: { n: 1 }, dedupeKey: "sync:a", runAt: T0 });
    let runs = 0;
    const h = {
      sync: (async () => {
        runs++;
        if (runs === 1) await enqueue(db, { type: "sync", payload: { n: 2 }, dedupeKey: "sync:a" });
      }) as Handler,
    };
    expect(await runOne(db, h, T0)).toBe("requeued");
    expect(await runOne(db, h, T0)).toBe("done");
    expect(runs).toBe(2);
    expect(await runOne(db, h, T0)).toBe("idle");
  });

  it("queued duplicates coalesce and the earlier request wins; permanent errors fail once", async () => {
    await enqueue(db, { type: "t", payload: {}, dedupeKey: "k", runAt: at(5 * MIN) });
    await enqueue(db, { type: "t", payload: {}, dedupeKey: "k", runAt: at(1 * MIN) });
    expect(await db.job.count()).toBe(1);
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(at(1 * MIN));
    const gone = {
      t: (async () => {
        throw new GithubError("not-found", "gone");
      }) as Handler,
    };
    expect(await runOne(db, gone, at(1 * MIN))).toBe("failed");
  });
});

describe("background job progress reaches open pages", () => {
  it("announces every finished job (success, retry and failure), and nothing when idle", async () => {
    const events: string[] = [];
    const h = { ok: (async () => {}) as Handler, down: (async () => { throw new GithubError("network", "Could not reach GitHub"); }) as Handler };
    expect(await drainJobs(h, (r) => events.push(r))).toBe(0);
    expect(events).toEqual([]);
    await enqueue(db, { type: "ok", payload: {}, dedupeKey: "a" });
    await enqueue(db, { type: "down", payload: {}, dedupeKey: "b" });
    expect(await drainJobs(h, (r) => events.push(r))).toBe(2);
    expect(events).toEqual(["state", "state"]);
  });
});
