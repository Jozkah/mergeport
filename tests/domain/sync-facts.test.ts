import { describe, expect, it } from "vitest";
import { syncFacts, type SpaceSyncInput } from "@/lib/domain/sync-facts";

const now = new Date("2026-10-29T12:00:00Z");
const base: SpaceSyncInput = { queued: 0, sending: 0, failed: 0, blocked: 0, conflicts: 0, deferred: 0, access: "OK", lastPushedAt: null, lastPolledAt: new Date(now.getTime() - 30_000), nextPollAt: new Date(now.getTime() + 20_000), rateLimitedUntil: null, lastError: null, canWrite: true, teammateDelaySeconds: 90, now };
const keys = (o: Partial<SpaceSyncInput>) => syncFacts({ ...base, ...o }).map((f) => f.key);

describe("sync facts", () => {
  it("says everything is published when nothing is pending", () => {
    expect(keys({})).toEqual(["saved"]);
  });

  it("separates saved-and-queued from sending from published", () => {
    expect(keys({ queued: 2 })).toEqual(["queued"]);
    expect(keys({ sending: 1 })).toEqual(["sending"]);
    const published = keys({ lastPushedAt: new Date(now.getTime() - 5 * 60_000) });
    expect(published).toEqual(["saved", "published"]);
  });

  it("a recent publish is waiting for teammates to poll, but only once nothing is left to send", () => {
    expect(keys({ lastPushedAt: new Date(now.getTime() - 20_000) })).toEqual(["saved", "published", "waiting-teammates"]);
    expect(keys({ lastPushedAt: new Date(now.getTime() - 20_000), queued: 1 })).toEqual(["queued", "published"]);
    const f = syncFacts({ ...base, lastPushedAt: new Date(now.getTime() - 20_000) }).find((x) => x.key === "waiting-teammates")!;
    expect(f.detail).toMatch(/app is open/);
  });

  it("holds are stated distinctly: conflict, blocked by authorization, unavailable, failed, rate limited, read only", () => {
    expect(keys({ conflicts: 1 })).toEqual(["conflict"]);
    expect(keys({ blocked: 3 })).toEqual(["blocked"]);
    expect(keys({ access: "REVOKED" })).toEqual(["unavailable"]);
    expect(keys({ failed: 1, lastError: "boom" })).toEqual(["failed"]);
    expect(syncFacts({ ...base, failed: 1, lastError: "boom" })[0].detail).toMatch(/boom/);
    expect(keys({ rateLimitedUntil: new Date(now.getTime() + 120_000) })).toEqual(["saved", "rate-limited"]);
    expect(keys({ canWrite: false })).toEqual(["saved", "read-only"]);
    expect(keys({ deferred: 2 })).toEqual(["saved", "deferred"]);
  });

  it("never reports 'everything published' while something is held or queued", () => {
    for (const o of [{ queued: 1 }, { conflicts: 1 }, { blocked: 1 }, { failed: 1 }, { sending: 1 }, { access: "REVOKED" }]) expect(keys(o)).not.toContain("saved");
  });
});
