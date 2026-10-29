import { beforeEach, describe, expect, it } from "vitest";
import { reviewCapacity, setAvailability } from "@/lib/services/capacity";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const NOW = new Date("2026-10-29T12:00:00Z");
const HOUR = 3_600_000;

describe("review capacity", () => {
  it("counts each person's queued reviews, with the oldest wait, most loaded first", async () => {
    const { db, admin } = S;
    const rows = await reviewCapacity(db, admin, NOW);
    expect(rows.length).toBeGreaterThan(1);
    const queued = rows.map((r) => r.queued);
    expect([...queued].sort((a, b) => b - a)).toEqual(queued);
    const busy = rows.find((r) => r.queued > 0)!;
    expect(busy.oldestSince).toBeInstanceOf(Date);
    expect(busy.oldestItemId).toBeTruthy();
    expect(rows.every((r) => !r.unavailable && r.suggestion === null)).toBe(true);
  });

  it("suggests a configured backup only for someone who is away with work queued, and only if the backup is free", async () => {
    const { db, admin } = S;
    const busy = (await reviewCapacity(db, admin, NOW)).find((r) => r.queued > 0)!;
    const other = (await reviewCapacity(db, admin, NOW)).find((r) => r.login !== busy.login)!;
    const requestsBefore = await db.reviewRequest.count();
    await setAvailability(db, admin, { login: busy.login, unavailableFrom: new Date(NOW.getTime() - HOUR), unavailableUntil: new Date(NOW.getTime() + 24 * HOUR), backupLogin: other.login, note: "on leave" });
    let row = (await reviewCapacity(db, admin, NOW)).find((r) => r.login === busy.login)!;
    expect(row).toMatchObject({ unavailable: true, backup: other.login.toLowerCase(), suggestion: other.login.toLowerCase(), note: "on leave" });
    // Nothing was reassigned or written to the work itself.
    expect(await db.reviewRequest.count()).toBe(requestsBefore);
    await setAvailability(db, admin, { login: other.login, unavailableFrom: new Date(NOW.getTime() - HOUR), unavailableUntil: new Date(NOW.getTime() + HOUR) });
    row = (await reviewCapacity(db, admin, NOW)).find((r) => r.login === busy.login)!;
    expect(row.suggestion).toBeNull(); // the backup is away too
    row = (await reviewCapacity(db, admin, new Date(NOW.getTime() + 48 * HOUR))).find((r) => r.login === busy.login)!;
    expect(row.unavailable).toBe(false); // the absence ended
  });

  it("lets people set only their own availability, rejects strangers, self-backup and reversed dates, and can clear", async () => {
    const { db, admin, a, b } = S;
    await expect(setAvailability(db, a, { login: b.login, unavailableFrom: NOW })).rejects.toThrow(/own availability/);
    await expect(setAvailability(db, admin, { login: "nobody-here", unavailableFrom: NOW })).rejects.toThrow(/not a member/);
    await expect(setAvailability(db, a, { login: a.login, backupLogin: a.login })).rejects.toThrow(/own backup/);
    await expect(setAvailability(db, a, { login: a.login, backupLogin: "ghost" })).rejects.toThrow(/backup must be/);
    await expect(setAvailability(db, a, { login: a.login, unavailableFrom: NOW, unavailableUntil: new Date(NOW.getTime() - HOUR) })).rejects.toThrow(/end must be after/);
    await setAvailability(db, a, { login: a.login, unavailableFrom: NOW });
    expect(await db.reviewerAvailability.count()).toBe(1);
    await setAvailability(db, a, { login: a.login, clear: true });
    expect(await db.reviewerAvailability.count()).toBe(0);
  });
});
