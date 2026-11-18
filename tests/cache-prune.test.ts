import { beforeEach, describe, expect, it } from "vitest";
import { dbCache } from "@/lib/github/factory";
import { CACHE_MAX_AGE_DAYS, CACHE_MAX_BYTES, maybePruneHttpCache, pruneHttpCache } from "@/lib/github/cache-prune";
import { testDb } from "./helpers";

const db = testDb();
const stats = async () => ({ rows: await db.publicCacheEntry.count(), bytes: (await db.publicCacheEntry.aggregate({ _sum: { bytes: true } }))._sum.bytes ?? 0 });

describe("ETag cache retention", () => {
  beforeEach(async () => {
    await db.publicCacheEntry.deleteMany();
  });

  it("keeps rows and bytes under the caps after 1000 large distinct writes", async () => {
    const cache = dbCache(db);
    const body = { blob: "x".repeat(200_000) };
    for (let i = 0; i < 1000; i++) await cache.set(`issues/${i}`, `"e${i}"`, body);
    await pruneHttpCache(db);
    const s = await stats();
    expect(s.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(s.rows).toBeLessThan(1000);
    expect(s.rows).toBeGreaterThan(0);
    // The newest write survives; the oldest was evicted first.
    expect(await cache.get("issues/999")).not.toBeNull();
    expect(await cache.get("issues/0")).toBeNull();
  }, 120_000);

  it("deletes entries past the age limit, keeps fresh ones, and is idempotent", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const day = 86_400_000;
    await db.publicCacheEntry.createMany({
      data: [
        { key: "old", etag: null, body: { a: 1 }, bytes: 7, fetchedAt: new Date(now.getTime() - (CACHE_MAX_AGE_DAYS + 1) * day) },
        { key: "fresh", etag: "e", body: { a: 2 }, bytes: 7, fetchedAt: new Date(now.getTime() - day) },
      ],
    });
    expect(await pruneHttpCache(db, now)).toEqual({ aged: 1, evicted: 0 });
    expect((await db.publicCacheEntry.findMany()).map((r) => r.key)).toEqual(["fresh"]);
    expect(await pruneHttpCache(db, now)).toEqual({ aged: 0, evicted: 0 });
    expect((await stats()).rows).toBe(1);
  });

  it("evicts by size idempotently and does not prune again inside the interval", async () => {
    const t = Date.now() + 365 * 86_400_000; // far ahead of the earlier test's throttle state
    await db.publicCacheEntry.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, body: { i }, bytes: CACHE_MAX_BYTES / 4, fetchedAt: new Date(t - (5 - i) * 1000) })) });
    const first = await pruneHttpCache(db, new Date(t));
    expect(first.evicted).toBe(2);
    expect((await db.publicCacheEntry.findMany({ orderBy: { key: "asc" } })).map((r) => r.key)).toEqual(["k2", "k3", "k4"]);
    expect(await pruneHttpCache(db, new Date(t))).toEqual({ aged: 0, evicted: 0 });

    const fresh = testDb();
    await maybePruneHttpCache(fresh, 1, t); // first call is due
    await db.publicCacheEntry.create({ data: { key: "stale", body: {}, bytes: 1, fetchedAt: new Date(t - 30 * 86_400_000) } });
    await maybePruneHttpCache(fresh, 1, t + 60_000); // inside the interval: no prune
    expect(await db.publicCacheEntry.count({ where: { key: "stale" } })).toBe(1);
    await maybePruneHttpCache(fresh, 1, t + 6 * 60_000); // interval elapsed
    expect(await db.publicCacheEntry.count({ where: { key: "stale" } })).toBe(0);
  });
});
