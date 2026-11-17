import { describe, expect, it } from "vitest";
import { buildDigest } from "@/lib/services/digest";
import { testDb } from "./helpers";
import { setupMapping } from "./updater-world";

const db = testDb();
const NOW = new Date("2026-11-18T09:00:00Z");

const run = (mappingId: string, state: string, finishedAt: Date) =>
  db.upstreamUpdateRun.create({ data: { mappingId, state, finishedAt, startedAt: finishedAt, triedShas: [], commits: [] } });

describe("daily digest: upstream auto-update runs", () => {
  it("a conflict, a failed verification or a PR to review shows under what needs me", async () => {
    const s = await setupMapping(db, null);
    for (const state of ["conflict", "verify-failed", "failed", "pr-opened", "merged-untested"]) {
      await db.upstreamUpdateRun.deleteMany({});
      await run(s.mapping.id, state, new Date("2026-11-17T20:00:00Z"));
      const d = await buildDigest(db, s.viewer, { now: NOW, tz: "UTC" });
      const e = d.attention.mine.entries.find((x) => x.key === `upstream-update:${s.mapping.id}`);
      expect(e, state).toMatchObject({ repo: "owner/proj", href: "/forks", title: "upstream/proj into owner/proj" });
      expect(e!.reason).toMatch(/Upstream update/);
    }
  });

  it("a later run that went through replaces the problem, and a run that needs nobody is not listed", async () => {
    const s = await setupMapping(db, null);
    await run(s.mapping.id, "conflict", new Date("2026-11-16T10:00:00Z"));
    await run(s.mapping.id, "up-to-date", new Date("2026-11-17T10:00:00Z"));
    expect((await buildDigest(db, s.viewer, { now: NOW, tz: "UTC" })).attention.mine.entries.some((x) => x.key.startsWith("upstream-update:"))).toBe(false);
    await db.upstreamUpdateRun.deleteMany({});
    await run(s.mapping.id, "promoted", new Date("2026-11-17T10:00:00Z"));
    expect((await buildDigest(db, s.viewer, { now: NOW, tz: "UTC" })).attention.mine.entries.some((x) => x.key.startsWith("upstream-update:"))).toBe(false);
  });

  it("a problem older than a week is left out", async () => {
    const s = await setupMapping(db, null);
    await run(s.mapping.id, "failed", new Date("2026-11-01T10:00:00Z"));
    expect((await buildDigest(db, s.viewer, { now: NOW, tz: "UTC" })).attention.mine.entries.some((x) => x.key.startsWith("upstream-update:"))).toBe(false);
  });
});
