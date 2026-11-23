import { beforeEach, describe, expect, it } from "vitest";
import { deliveryAnalytics } from "@/lib/services/planning-insight";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
  await S.db.reviewRequest.deleteMany();
  await S.db.workItemComment.deleteMany({ where: { kind: "REVIEW" } });
});

const H = 3_600_000;
const T0 = new Date("2026-10-20T10:00:00Z");

async function setup(request: { ref: string; id: bigint | null }, review: { login: string; id: bigint | null }) {
  const { db, ids } = S;
  const card = await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cApiPr.id }, select: { workItemId: true } });
  const workItemId = card.workItemId!;
  await db.reviewRequest.create({ data: { workItemId, kind: "USER", reviewerRef: request.ref, reviewerGithubId: request.id, requestedAt: T0 } });
  await db.workItemComment.create({ data: { workItemId, githubId: 4242n, kind: "REVIEW", authorLogin: review.login, authorGithubId: review.id, reviewState: "APPROVED", createdAtGh: new Date(T0.getTime() + H), updatedAtGh: new Date(T0.getTime() + H) } });
}
const wait = async () => (await deliveryAnalytics(S.db, S.admin, S.ids.projects.atlas.id)).reviewWait;

describe("review wait pairs a request with that person's review by GitHub id", () => {
  it("a renamed reviewer's first review still counts", async () => {
    await setup({ ref: "new-name", id: 5n }, { login: "old-name", id: 5n });
    expect(await wait()).toEqual({ count: 1, medianMs: H });
  });

  it("a review by someone who now holds the old login is not paired with the new owner's request", async () => {
    await setup({ ref: "old-name", id: 9n }, { login: "old-name", id: 5n });
    expect((await wait()).count).toBe(0);
  });

  it("without ids the login still pairs them", async () => {
    await setup({ ref: "Old-Name", id: null }, { login: "old-name", id: null });
    expect(await wait()).toEqual({ count: 1, medianMs: H });
  });
});
