import { describe, expect, it } from "vitest";
import { deriveSourceStatus, type SourceCounts } from "@/lib/sync/source-status";

const base: SourceCounts = { tracked: 5, running: 0, queued: 0, refused: 0, rateLimited: 0, failed: 0, neverSynced: 0 };
const s = (o: Partial<SourceCounts>) => deriveSourceStatus({ ...base, ...o });

describe("source refresh status for the top bar", () => {
  it("shows nothing when no repository is tracked", () => expect(s({ tracked: 0 })).toBeNull());
  it("reports syncing only while jobs are really queued or running", () => {
    expect(s({ running: 1, queued: 4 })?.state).toBe("syncing");
    expect(s({})?.state).toBe("synced");
  });
  it("keeps authorization and network failures apart", () => {
    expect(s({ refused: 1 })?.state).toBe("signin");
    expect(s({ failed: 2 })?.state).toBe("offline");
    expect(s({ refused: 1, failed: 2 })?.state).toBe("signin");
  });
  it("a failure waiting for its retry is offline; the retry actually running is syncing", () => {
    expect(s({ failed: 1, queued: 1 })?.state).toBe("offline");
    expect(s({ failed: 1, running: 1 })?.state).toBe("syncing");
  });
  it("says unsynchronized repositories are unknown, not empty", () => {
    expect(s({ running: 1, neverSynced: 3 })?.detail).toMatch(/unknown, not zero/);
    expect(s({ neverSynced: 3 })?.detail).toMatch(/not been synchronized/);
  });
  it("reports rate limits separately", () => expect(s({ rateLimited: 1 })?.state).toBe("rate-limited"));
});
