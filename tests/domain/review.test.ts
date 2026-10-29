import { describe, expect, it } from "vitest";
import { deriveReview, type ReviewInput, type ReviewEvent } from "@/lib/domain/review";

const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
const now = new Date(Date.UTC(2026, 9, 2, 0));

function base(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    type: "PULL_REQUEST",
    state: "OPEN",
    draft: false,
    authorLogin: "author",
    headSha: "bbbbbbb",
    checksState: "SUCCESS",
    mergeable: "MERGEABLE",
    reviews: [],
    requests: [],
    rule: null,
    readyAt: t(0),
    internalLogins: new Set(["me", "teammate", "author"]),
    now,
    ...over,
  };
}
const review = (reviewer: string, state: ReviewEvent["state"], commitSha: string | null, at = 5): ReviewEvent => ({ reviewer, state, commitSha, submittedAt: t(at) });

describe("review derivation", () => {
  it("puts a PR in Needs my review when GitHub requested me, with request time and evidence", () => {
    const d = deriveReview(base({ requests: [{ kind: "USER", ref: "Me", requestedAt: t(2) }] }), "me");
    expect(d.queues.needsMyReview).toBe(true);
    expect(d.primary).toBe("NEEDS_MY_REVIEW");
    expect(d.waiting?.since).toEqual(t(2));
    expect(d.waiting?.sinceBasis).toBe("request");
    expect(d.actors[0].evidence).toMatch(/request is open/);
  });

  it("does not ask the author to review their own PR", () => {
    const d = deriveReview(base({ requests: [{ kind: "USER", ref: "author", requestedAt: t(2) }] }), "author");
    expect(d.queues.needsMyReview).toBe(false);
  });

  it("waits on an external maintainer named by a label rule, not on the viewer", () => {
    const d = deriveReview(
      base({
        rule: { id: "r1", tier: "repository override", semantics: "ANY", reason: "needs-maintainer-review label", reviewers: [{ kind: "USER", ref: "maintainer" }] },
      }),
      "me",
    );
    expect(d.queues.waitingExternal).toBe(true);
    expect(d.queues.needsMyReview).toBe(false);
    expect(d.primary).toBe("WAITING_EXTERNAL");
    expect(d.waiting?.sinceBasis).toBe("ready");
    expect(d.explanation[0]).toMatch(/needs-maintainer-review/);
  });

  it("treats an approval on an older commit as stale and restarts the wait", () => {
    const d = deriveReview(
      base({
        rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "USER", ref: "teammate" }] },
        reviews: [review("teammate", "APPROVED", "aaaaaaa")],
      }),
      "teammate",
    );
    expect(d.satisfied).toBe(false);
    expect(d.staleApprovals).toEqual(["teammate"]);
    expect(d.queues.needsMyReview).toBe(true);
  });

  it("counts a fresh approval on the current head as satisfied", () => {
    const d = deriveReview(
      base({
        rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "USER", ref: "teammate" }] },
        reviews: [review("teammate", "APPROVED", "bbbbbbb")],
      }),
      "me",
    );
    expect(d.satisfied).toBe(true);
    expect(d.primary).toBe("APPROVED");
    expect(d.waiting).toBeNull();
  });

  it("ALL semantics stays pending until every reviewer approves; ANY is satisfied by one", () => {
    const reviewers = [
      { kind: "USER" as const, ref: "teammate" },
      { kind: "USER" as const, ref: "maintainer" },
    ];
    const reviews = [review("teammate", "APPROVED", "bbbbbbb")];
    const all = deriveReview(base({ rule: { id: "r", tier: "t", semantics: "ALL", reason: "x", reviewers }, reviews }), "me");
    const any = deriveReview(base({ rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers }, reviews }), "me");
    expect(all.satisfied).toBe(false);
    expect(all.queues.waitingExternal).toBe(true);
    expect(any.satisfied).toBe(true);
  });

  it("a plain comment is never an approval", () => {
    const d = deriveReview(
      base({ rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "USER", ref: "maintainer" }] }, reviews: [review("maintainer", "COMMENTED", "bbbbbbb")] }),
      "me",
    );
    expect(d.satisfied).toBe(false);
  });

  it("a dismissed review no longer counts", () => {
    const d = deriveReview(
      base({
        rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "USER", ref: "maintainer" }] },
        reviews: [review("maintainer", "APPROVED", "bbbbbbb", 3), review("maintainer", "DISMISSED", "bbbbbbb", 4)],
      }),
      "me",
    );
    expect(d.satisfied).toBe(false);
  });

  it("changes requested surfaces as action needed for the author only", () => {
    const input = base({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(1) }], reviews: [review("teammate", "CHANGES_REQUESTED", "bbbbbbb")] });
    expect(deriveReview(input, "author").queues.changesRequestedForMe).toBe(true);
    expect(deriveReview(input, "me").queues.changesRequestedForMe).toBe(false);
    expect(deriveReview(input, "author").primary).toBe("CHANGES_REQUESTED");
  });

  it("a re-request after an earlier review makes the reviewer pending again", () => {
    const d = deriveReview(
      base({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(8) }], reviews: [review("teammate", "APPROVED", "bbbbbbb", 5)] }),
      "teammate",
    );
    expect(d.queues.needsMyReview).toBe(true);
    expect(d.actors[0].evidence).toMatch(/Re-review requested/);
  });

  it("a cancelled request no longer waits unless the rule still requires the person", () => {
    const requestOnly = deriveReview(base({ cancelledRequests: [{ kind: "USER", ref: "teammate", requestedAt: t(1) }] }), "teammate");
    expect(requestOnly.queues.needsMyReview).toBe(false);
    expect(requestOnly.primary).toBe("UNKNOWN");
    const ruled = deriveReview(
      base({
        cancelledRequests: [{ kind: "USER", ref: "teammate", requestedAt: t(1) }],
        rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "USER", ref: "teammate" }] },
      }),
      "teammate",
    );
    expect(ruled.queues.needsMyReview).toBe(true);
    expect(ruled.actors[0].evidence).toMatch(/cancelled/);
  });

  it("an unreadable team is Unknown, not approved and not silently dropped", () => {
    const d = deriveReview(
      base({ rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "TEAM", ref: "org/maintainers" }] }, teamMembers: { "org/maintainers": null } }),
      "me",
    );
    expect(d.actors[0].status).toBe("UNAVAILABLE");
    expect(d.satisfied).toBe(false);
    expect(d.explanation.join(" ")).toMatch(/could not be resolved/);
  });

  it("team members can satisfy a team rule", () => {
    const d = deriveReview(
      base({
        rule: { id: "r", tier: "t", semantics: "ANY", reason: "x", reviewers: [{ kind: "TEAM", ref: "org/maintainers" }] },
        teamMembers: { "org/maintainers": ["maint1"] },
        reviews: [review("maint1", "APPROVED", "bbbbbbb")],
      }),
      "me",
    );
    expect(d.satisfied).toBe(true);
  });

  it("external roles need an explicit manual clearing; nothing else clears them", () => {
    const rule = { id: "r", tier: "t", semantics: "ANY" as const, reason: "Legal sign-off", reviewers: [{ kind: "EXTERNAL_ROLE" as const, ref: "legal" }] };
    expect(deriveReview(base({ rule }), "me").satisfied).toBe(false);
    expect(deriveReview(base({ rule, manuallyCleared: new Set(["legal"]) }), "me").satisfied).toBe(true);
  });

  it("blocked by failing checks, conflicts or dependencies outranks review state", () => {
    const d = deriveReview(base({ checksState: "FAILURE", mergeable: "CONFLICTING", blockedByDependencies: 2, requests: [{ kind: "USER", ref: "me", requestedAt: t(1) }] }), "me");
    expect(d.primary).toBe("BLOCKED");
    expect(d.blockedReasons).toHaveLength(3);
    expect(d.queues.needsMyReview).toBe(true); // still in the review queue; blocked is a separate dimension
  });

  it("drafts and closed PRs are in no review queue", () => {
    const draft = deriveReview(base({ draft: true, requests: [{ kind: "USER", ref: "me", requestedAt: t(1) }] }), "me");
    expect(draft.queues.needsMyReview).toBe(false);
    const closed = deriveReview(base({ state: "CLOSED", requests: [{ kind: "USER", ref: "me", requestedAt: t(1) }] }), "me");
    expect(closed.applicable).toBe(false);
  });

  it("issues are not derived from PR review data", () => {
    expect(deriveReview(base({ type: "ISSUE" }), "me").applicable).toBe(false);
  });
});
