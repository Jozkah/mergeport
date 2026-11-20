import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claim, enqueue, runOne, type Handler } from "@/lib/jobs";
import { truncateAll } from "@/lib/demo/seed";
import { testDb } from "./helpers";
import { createPrisma } from "@/lib/db";

const db = testDb();
const extra: ReturnType<typeof createPrisma>[] = [];
const another = () => {
  const c = createPrisma(undefined, { max: 3 }); // same database, its own pool: contends like a separate process
  extra.push(c);
  return c;
};
afterAll(async () => void (await Promise.all(extra.map((c) => c.$disconnect()))));
const T0 = new Date("2026-10-29T10:00:00Z");

beforeEach(async () => {
  await truncateAll(db);
});

/** A worker loop: claims and runs until the queue is idle. Each worker has its own client, so they contend like separate processes. */
async function worker(client: typeof db, handlers: Record<string, Handler>) {
  let n = 0;
  for (;;) {
    const r = await runOne(client, handlers, T0);
    if (r === "idle") return n;
    n++;
  }
}

describe("two workers on one database", () => {
  it("each of N jobs runs exactly once", async () => {
    const N = 40;
    for (let i = 0; i < N; i++) await enqueue(db, { type: "work", payload: { i }, runAt: T0 });
    const seen: number[] = [];
    const h = {
      work: (async (p: { i: number }) => {
        seen.push(p.i);
        await new Promise((r) => setTimeout(r, 5));
      }) as Handler,
    };
    const a = another();
    const b = another();
    const [na, nb] = await Promise.all([worker(a, h), worker(b, h)]);
    expect(na + nb).toBe(N);
    expect(na).toBeGreaterThan(0);
    expect(nb).toBeGreaterThan(0);
    expect([...seen].sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(await db.job.count({ where: { status: "DONE" } })).toBe(N);
  });

  it("concurrent claim() of one job gives it to exactly one caller", async () => {
    await enqueue(db, { type: "work", payload: {}, runAt: T0 });
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(db, T0)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const j = await db.job.findFirstOrThrow();
    expect(j.status).toBe("RUNNING");
    expect(j.attempts).toBe(1);
  });

  it("oldest due job first, future jobs not claimed", async () => {
    await enqueue(db, { type: "late", payload: {}, runAt: new Date(T0.getTime() + 60_000) });
    await enqueue(db, { type: "b", payload: {}, runAt: new Date(T0.getTime() - 1000) });
    await enqueue(db, { type: "a", payload: {}, runAt: new Date(T0.getTime() - 5000) });
    expect((await claim(db, T0))?.type).toBe("a");
    expect((await claim(db, T0))?.type).toBe("b");
    expect(await claim(db, T0)).toBeNull();
  });

  it("dedupeKey keeps one job across workers, and a trigger during a run reruns it once", async () => {
    await enqueue(db, { type: "sync", payload: { n: 1 }, dedupeKey: "k", runAt: T0 });
    await enqueue(db, { type: "sync", payload: { n: 2 }, dedupeKey: "k", runAt: T0 });
    expect(await db.job.count()).toBe(1);
    let runs = 0;
    const h = {
      sync: (async () => {
        runs++;
        if (runs === 1) await enqueue(db, { type: "sync", payload: { n: 3 }, dedupeKey: "k", runAt: T0 }); // arrives while RUNNING
      }) as Handler,
    };
    const a = another();
    expect(await runOne(db, h, T0)).toBe("requeued"); // dirty: queued again, not finished
    expect(await runOne(a, h, T0)).toBe("done"); // a different worker picks up the rerun
    expect(await runOne(db, h, T0)).toBe("idle");
    expect(runs).toBe(2);
  });

  it("a recurring job is requeued one interval later by whichever worker ran it", async () => {
    await db.job.create({ data: { type: "tick", payload: {}, dedupeKey: "tick", intervalMs: 60_000, runAt: T0 } });
    const a = another();
    expect(await runOne(a, { tick: (async () => {}) as Handler }, T0)).toBe("requeued");
    expect((await db.job.findFirstOrThrow()).runAt).toEqual(new Date(T0.getTime() + 60_000));
    expect(await runOne(db, { tick: (async () => {}) as Handler }, T0)).toBe("idle");
  });
});
