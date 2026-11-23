import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { moveCard, requestManualReview, resolveManualReview } from "@/lib/services/planning";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("planning concurrency on this computer", () => {
  it("a stale version is refused and the card is not moved; the winner's move stands", async () => {
    const { db, a, ids } = S;
    const id = ids.cards.cWeb.id;
    const before = await db.planningItem.findUniqueOrThrow({ where: { id } });
    const first = await moveCard(db, a, { itemId: id, toColumnKey: "done", expectedVersion: before.version });
    expect(first.version).toBeGreaterThan(before.version);
    await expect(moveCard(db, a, { itemId: id, toColumnKey: "ready", expectedVersion: before.version })).rejects.toBeInstanceOf(ConflictError);
    const after = await db.planningItem.findUniqueOrThrow({ where: { id }, include: { column: true } });
    expect(after.column.key).toBe("done");
  });

  it("two racing moves with the same version: exactly one wins", async () => {
    const { db, a, ids } = S;
    const id = ids.cards.cWeb.id;
    const v = (await db.planningItem.findUniqueOrThrow({ where: { id } })).version;
    const results = await Promise.allSettled([moveCard(db, a, { itemId: id, toColumnKey: "done", expectedVersion: v }), moveCard(db, a, { itemId: id, toColumnKey: "ready", expectedVersion: v })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("manual waiting", () => {
  it("only the named reviewer or an administrator can decide, and the record is cleared with a reason", async () => {
    const { db, admin, a, b, ids } = S;
    const rec = await requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "USER", reviewerRef: "bram-demo", reason: "Needs design sign-off" });
    await expect(resolveManualReview(db, a, rec.id, "SATISFIED", "self-approve")).rejects.toBeInstanceOf(ForbiddenError);
    await resolveManualReview(db, b, rec.id, "SATISFIED", "looks good");
    const done = await db.waitingRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(done).toMatchObject({ status: "SATISFIED", clearReason: "looks good" });
    const second = await requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "EXTERNAL_ROLE", reviewerRef: "legal", reason: "Licence check" });
    await resolveManualReview(db, admin, second.id, "CANCELLED", "no longer needed");
    await expect(resolveManualReview(db, admin, second.id, "CANCELLED", "again")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires a reason", async () => {
    const { db, a, ids } = S;
    await expect(requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "USER", reviewerRef: "x", reason: "  " })).rejects.toThrow(/why/i);
  });
});
