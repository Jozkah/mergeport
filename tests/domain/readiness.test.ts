import { describe, expect, it } from "vitest";
import { deriveReview, type ReviewInput } from "@/lib/domain/review";
import { deriveReadiness, type ReadinessInput } from "@/lib/domain/readiness";

const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
const now = new Date(Date.UTC(2026, 9, 2, 0));
const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  type: "PULL_REQUEST", state: "OPEN", draft: false, authorLogin: "author", headSha: "abcdef123", checksState: "SUCCESS", mergeable: "MERGEABLE",
  reviews: [], requests: [], rule: null, readyAt: t(0), internalLogins: new Set(["me", "teammate", "author"]), now, ...over,
});
const ready = (rIn: Partial<ReviewInput>, over: Partial<ReadinessInput> = {}) => {
  const input = review(rIn);
  return deriveReadiness({ state: input.state, draft: input.draft, authorLogin: input.authorLogin, headSha: input.headSha ?? null, checksState: input.checksState, mergeable: input.mergeable, derivation: deriveReview(input, "me"), stages: [], dependencyBlockers: 0, ...over });
};
const row = (r: ReturnType<typeof ready>, k: string) => r.rows.find((x) => x.key === k)!;
const approvedBy = { requests: [{ kind: "USER" as const, ref: "teammate", requestedAt: t(2) }], reviews: [{ reviewer: "teammate", state: "APPROVED" as const, commitSha: "abcdef123", submittedAt: t(5) }] };

describe("pull request readiness", () => {
  it("is ready only with current approval, green checks, no conflicts and nothing waiting", () => {
    const r = ready(approvedBy);
    expect(r.ready).toBe(true);
    expect(r.nextAction).toMatch(/Ready/);
  });

  it("never reports unknown evidence as passing", () => {
    const r = ready({ ...approvedBy, checksState: "NONE", mergeable: "UNKNOWN" });
    expect(row(r, "checks").state).toBe("unknown");
    expect(row(r, "conflicts").state).toBe("unknown");
    expect(row(r, "discussions").state).toBe("unknown");
    expect(r.ready).toBe(false);
    const noReview = ready({});
    expect(row(noReview, "reviews").state).toBe("unknown");
  });

  it("names the author as next when checks fail, conflicts exist or changes were requested", () => {
    expect(ready({ ...approvedBy, checksState: "FAILURE" }).nextBy).toEqual(["author"]);
    expect(ready({ ...approvedBy, mergeable: "CONFLICTING" }).nextAction).toMatch(/conflicts/);
    const changes = ready({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(2) }], reviews: [{ reviewer: "teammate", state: "CHANGES_REQUESTED", commitSha: "abcdef123", submittedAt: t(5) }] });
    expect(changes.nextBy).toEqual(["author"]);
    expect(row(changes, "reviews").state).toBe("blocked");
  });

  it("marks stale approvals and does not call a stale approval ready", () => {
    const r = ready({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(2) }], reviews: [{ reviewer: "teammate", state: "APPROVED", commitSha: "older", submittedAt: t(5) }] });
    expect(row(r, "stale").evidence).toMatch(/teammate/);
    expect(r.ready).toBe(false);
  });

  it("a stage still waiting (for example the maintainer's merge) means not ready, and names its owner", () => {
    const stages = [{ stage: "MAINTAINER_MERGE" as const, owners: ["maintainer"], reason: "r", since: t(5), elapsedMs: 1000, nextAction: "maintainer merges", source: "rule" as const }];
    const r = ready(approvedBy, { stages });
    expect(r.ready).toBe(false);
    expect(r.nextBy).toEqual(["maintainer"]);
  });

  it("planning blockers block readiness and say they are advice, not a GitHub rule", () => {
    const r = ready(approvedBy, { dependencyBlockers: 2 });
    expect(row(r, "dependencies")).toMatchObject({ state: "blocked", source: "dashboard" });
    expect(row(r, "dependencies").evidence).toMatch(/not a GitHub rule/);
    expect(r.ready).toBe(false);
  });

  it("drafts, merged and closed items have their own next step", () => {
    expect(ready({ draft: true }).nextAction).toMatch(/ready for review/);
    expect(ready({ state: "MERGED" }).nextAction).toBe("Merged");
  });
});
