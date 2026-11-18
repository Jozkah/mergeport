import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubError } from "@/lib/github/port";
import { enqueue, ensureRecurring, reclaimStuck, runOne, type Handler } from "@/lib/jobs";
import { truncateAll } from "@/lib/demo/seed";
import { drainJobs, paceReconcile, RECONCILE_IDLE_EVERY_MS, RECONCILE_START_DELAY_MS, runJobLane, step } from "@/lib/local/scheduler";
import { RECONCILE_EVERY_MS } from "@/lib/local/handlers";
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

  it("an enqueue that lands just before the final completion write is not lost (B09)", async () => {
    await enqueue(db, { type: "refresh", payload: { n: 1 }, dedupeKey: "refresh", runAt: T0 });
    const real = db.job.updateMany.bind(db.job);
    let injected = false;
    const spy = vi.spyOn(db.job, "updateMany").mockImplementation(((args: Parameters<typeof real>[0]) => {
      // The first write the runner makes after the handler is the completion write: let a second request arrive right before it.
      if (!injected && (args.data as { status?: string }).status === "DONE") {
        injected = true;
        return enqueue(db, { type: "refresh", payload: { n: 2 }, dedupeKey: "refresh", runAt: T0 }).then(() => real(args));
      }
      return real(args);
    }) as unknown as typeof db.job.updateMany);
    const seen: number[] = [];
    const h = { refresh: (async (p: { n: number }) => { seen.push(p.n); }) as unknown as Handler };
    expect(await runOne(db, h, T0)).toBe("requeued");
    spy.mockRestore();
    const j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("QUEUED");
    expect(j.dirty).toBe(false);
    expect(await runOne(db, h, T0)).toBe("done");
    expect(seen).toEqual([1, 2]);
  });
});

describe("independent lanes (a hung job never stalls coordination or the other jobs)", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a handler that never resolves: engine.tick keeps running each tick and digest.daily still runs", async () => {
    const past = new Date(Date.now() - MIN);
    await enqueue(db, { type: "hang", payload: {}, dedupeKey: "hang", runAt: past });
    await ensureRecurring(db, { type: "digest.daily", key: "digest", intervalMs: 10 * MIN, firstRunAt: new Date(past.getTime() + 1) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let engineTicks = 0;
    let digests = 0;
    const h = { hang: (() => new Promise<void>(() => {})) as Handler, "digest.daily": (async () => void digests++) as Handler };
    const s = { busy: false, coordBusy: false };
    const lanes = { coordinate: async () => void engineTicks++, drain: () => drainJobs(h, () => {}, 5, 50) };
    const t1 = step(s, lanes); // the job lane claims "hang" and blocks on it
    await t1.coordination;
    await settle(10);
    expect(s.busy).toBe(true);
    const t2 = step(s, lanes); // coordination is not held up by the hung job; the job lane is not started twice
    expect(t2.jobs).toBeUndefined();
    await t2.coordination;
    expect(engineTicks).toBe(2);
    expect(await t1.jobs).toBe(true); // the budget released the lane
    expect(errors.mock.calls.some((c) => /budget/.test(String(c[0])))).toBe(true);
    expect(s.busy).toBe(false);
    const t3 = step(s, lanes);
    await Promise.all([t3.coordination, t3.jobs]);
    expect(engineTicks).toBe(3);
    expect(digests).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { dedupeKey: "hang" } })).status).toBe("RUNNING"); // visible, reclaimStuck owns it
    errors.mockRestore();
  });

  it("a failing coordination lane is logged and the job lane still runs, and the other way round", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = { busy: false, coordBusy: false };
    let drains = 0;
    const a = step(s, { coordinate: async () => { throw new Error("coord down"); }, drain: async () => ++drains });
    await Promise.all([a.coordination, a.jobs]);
    expect(drains).toBe(1);
    let coords = 0;
    const b = step(s, { coordinate: async () => ++coords, drain: async () => { throw new Error("jobs down"); } });
    await Promise.all([b.coordination, b.jobs]);
    expect(coords).toBe(1);
    expect(s).toEqual({ busy: false, coordBusy: false });
    expect(errors.mock.calls.map((c) => String(c[1]))).toEqual(["coord down", "jobs down"]);
    errors.mockRestore();
  });

  it("runJobsNow-style drains and tick drains never overlap", async () => {
    const s = { busy: false, coordBusy: false };
    let live = 0;
    let peak = 0;
    let runs = 0;
    const drain = async () => {
      live++;
      peak = Math.max(peak, live);
      runs++;
      await settle(20);
      live--;
      return 0;
    };
    const started = [runJobLane(s, drain), step(s, { coordinate: async () => {}, drain }).jobs, runJobLane(s, drain), runJobLane(s, drain)];
    const res = await Promise.all(started.map((p) => p ?? Promise.resolve(false)));
    expect(res).toEqual([true, false, false, false]);
    expect(peak).toBe(1);
    expect(runs).toBe(1);
  });
});

describe("reconcile cadence follows activity", () => {
  const T = T0.getTime();
  const row = () => db.job.findUniqueOrThrow({ where: { dedupeKey: "reconcile" } });

  it("the first reconcile after start waits the start delay instead of firing at once", async () => {
    await paceReconcile("active", T, T);
    expect((await row()).runAt).toEqual(new Date(T + RECONCILE_START_DELAY_MS));
    // An overdue row from an earlier run of the app is also pushed past the start delay.
    await db.job.updateMany({ data: { runAt: new Date(T - 3 * 60 * MIN) } });
    await paceReconcile("idle", T + MIN, T);
    expect((await row()).runAt).toEqual(new Date(T + RECONCILE_START_DELAY_MS));
  });

  it("idle stretches the interval to 60 min, active restores 15 min", async () => {
    expect(RECONCILE_IDLE_EVERY_MS).toBe(60 * MIN);
    await paceReconcile("active", T, T - 60 * MIN); // started long ago: no start delay
    let runs = 0;
    const h = { "reconcile.all": (async () => void runs++) as Handler };
    expect(await runOne(db, h, at(0))).toBe("requeued");
    expect((await row()).runAt).toEqual(at(RECONCILE_EVERY_MS));
    await paceReconcile("idle", T + MIN, T - 60 * MIN);
    let j = await row();
    expect(j.intervalMs).toBe(RECONCILE_IDLE_EVERY_MS);
    expect(j.runAt).toEqual(at(60 * MIN)); // the pending run moved out
    expect(await runOne(db, h, at(20 * MIN))).toBe("idle");
    expect(await runOne(db, h, at(60 * MIN))).toBe("requeued");
    expect((await row()).runAt).toEqual(at(120 * MIN)); // idle cadence after an idle run
    await paceReconcile("active", T + 61 * MIN, T - 60 * MIN);
    j = await row();
    expect(j.intervalMs).toBe(RECONCILE_EVERY_MS);
    expect(j.runAt).toEqual(at(75 * MIN)); // a tab came back: 15 min after the last run
    expect(runs).toBe(2);
  });

  it("a retry back-off is not moved by the cadence", async () => {
    await paceReconcile("active", T, T - 60 * MIN);
    await db.job.updateMany({ data: { finishedAt: at(0), runAt: at(2 * MIN) } });
    await paceReconcile("idle", T + MIN, T - 60 * MIN);
    expect((await row()).runAt).toEqual(at(2 * MIN));
  });
});
