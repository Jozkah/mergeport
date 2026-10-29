import { beforeEach, describe, expect, it } from "vitest";
import { inbox, markAllRead, markDone, markRead, reopen, snooze } from "@/lib/services/inbox";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const HOUR = 3_600_000;

describe("actionable inbox", () => {
  it("lists what needs the viewer, unread first, and counts it", async () => {
    const { db, a } = S;
    const r = await inbox(db, a);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.counts.open).toBe(r.entries.length);
    expect(r.unread).toBe(r.entries.length);
    expect(r.entries.every((e) => e.reasons.length > 0)).toBe(true);
  });

  it("read, done and snooze are personal and do not touch GitHub-derived review state", async () => {
    const { db, a, b } = S;
    const first = (await inbox(db, a)).entries[0];
    const stateBefore = JSON.stringify(first.derived.derivation.actors);
    await markRead(db, a, first.item.id);
    const afterRead = await inbox(db, a);
    expect(afterRead.unread).toBe(afterRead.entries.length - 1);
    await markDone(db, a, first.item.id);
    const after = await inbox(db, a);
    expect(after.entries.find((e) => e.item.id === first.item.id)).toBeUndefined();
    expect((await inbox(db, a, { status: "done" })).entries.map((e) => e.item.id)).toContain(first.item.id);
    // Acknowledging is not approving: the derived review state is exactly what it was, and nothing was written to the item or its reviews.
    const again = (await inbox(db, a, { status: "done" })).entries.find((e) => e.item.id === first.item.id)!;
    expect(JSON.stringify(again.derived.derivation.actors)).toBe(stateBefore);
    expect(await db.workItemComment.count({ where: { workItemId: first.item.id, kind: "REVIEW", reviewState: "APPROVED", authorLogin: a.login } })).toBe(0);
    // Another person's inbox is unaffected.
    const theirs = await inbox(db, b);
    expect(theirs.entries.every((e) => e.status === "open")).toBe(true);
  });

  it("a done item returns when a new review request, commit or comment arrives (not before)", async () => {
    const { db, a } = S;
    const first = (await inbox(db, a)).entries[0];
    await markDone(db, a, first.item.id);
    expect((await inbox(db, a)).entries.map((e) => e.item.id)).not.toContain(first.item.id);
    await db.workItem.update({ where: { id: first.item.id }, data: { headSha: "f".repeat(40) } });
    const r = await inbox(db, a);
    const back = r.entries.find((e) => e.item.id === first.item.id);
    expect(back?.status).toBe("open");
    expect(back?.unread).toBe(true);
  });

  it("a snoozed item stays hidden until the time passes or something changes, and can be reopened", async () => {
    const { db, a } = S;
    const first = (await inbox(db, a)).entries[0];
    const now = new Date("2026-10-29T12:00:00Z");
    await snooze(db, a, first.item.id, new Date(now.getTime() + 4 * HOUR));
    const hidden = await inbox(db, a, { now });
    expect(hidden.entries.map((e) => e.item.id)).not.toContain(first.item.id);
    expect((await inbox(db, a, { now, status: "snoozed" })).entries).toHaveLength(1);
    expect((await inbox(db, a, { now: new Date(now.getTime() + 5 * HOUR) })).entries.map((e) => e.item.id)).toContain(first.item.id);
    await reopen(db, a, first.item.id);
    expect((await inbox(db, a, { now })).entries.map((e) => e.item.id)).toContain(first.item.id);
  });

  it("marks everything read in one step, and refuses items that are not in the viewer's inbox", async () => {
    const { db, a, ids } = S;
    await markAllRead(db, a);
    expect((await inbox(db, a)).unread).toBe(0);
    await expect(markDone(db, a, ids.items.web9.id + "-nope")).rejects.toThrow(/not in your inbox/);
  });
});

describe("stages through the services", () => {
  it("a stage rule and a manual stage record reach the derived item and survive manual-waiting creation", async () => {
    const { db, admin, ids } = S;
    const { attention } = await import("@/lib/services/queries");
    const { requestManualReview } = await import("@/lib/services/planning");
    await db.waitingRule.create({ data: { workspaceId: admin.workspaceId, scope: "WORKSPACE", itemType: "PULL_REQUEST", waitingOn: [{ kind: "EXTERNAL_ROLE", ref: "maintainer" }], reason: "maintainer merges", stage: "MAINTAINER_MERGE" } });
    await requestManualReview(db, admin, { workItemId: ids.items.web9.id, reviewerKind: "EXTERNAL_ROLE", reviewerRef: "upstream", reason: "1.4 release", stage: "UPSTREAM_RELEASE" });
    await requestManualReview(db, admin, { workItemId: ids.items.web9.id, reviewerKind: "USER", reviewerRef: "x", reason: "bogus stage is dropped", stage: "nonsense" });
    const q = await attention(db, admin);
    const all = [...q.waitingExternal, ...q.needsTeamReview, ...q.needsMyReview, ...q.manualWaiting, ...q.blocked, ...q.changesRequested];
    const web9 = all.find((d) => d.item.id === ids.items.web9.id)!;
    expect(web9.stages.map((s) => s.stage)).toEqual(expect.arrayContaining(["MAINTAINER_MERGE", "UPSTREAM_RELEASE"]));
    expect((await db.waitingRecord.findMany({ where: { workItemId: ids.items.web9.id } })).map((r) => r.stage).sort()).toEqual(["", "UPSTREAM_RELEASE"]);
  });
});
