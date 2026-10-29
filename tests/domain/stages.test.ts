import { describe, expect, it } from "vitest";
import { deriveReview, type ReviewInput } from "@/lib/domain/review";
import { applyWaitingRules, type WaitingRuleRow } from "@/lib/domain/waiting-rules";
import { deriveStages } from "@/lib/domain/stages";

const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
const now = new Date(Date.UTC(2026, 9, 2, 0));

const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  type: "PULL_REQUEST", state: "OPEN", draft: false, authorLogin: "author", headSha: "h1", checksState: "SUCCESS", mergeable: "MERGEABLE",
  reviews: [], requests: [], rule: null, readyAt: t(0), internalLogins: new Set(["me", "teammate", "author"]), now, ...over,
});
const rule = (over: Partial<WaitingRuleRow> = {}): WaitingRuleRow => ({
  id: "w1", scope: "WORKSPACE", repositoryId: null, ownerLogin: null, projectId: null, itemType: "PULL_REQUEST", labels: [], authors: [], includeDrafts: false,
  waitingOn: [{ kind: "EXTERNAL_ROLE", ref: "maintainer" }], reason: "the maintainer merges everything", enabled: true, ...over,
});
const run = (input: ReviewInput, matched: WaitingRuleRow[], manual: Parameters<typeof deriveStages>[0]["manual"] = []) => {
  const d = applyWaitingRules(deriveReview(input, "me"), input, matched, "me");
  return deriveStages({ derivation: d, input, matched, manual, now });
};

describe("hand-off stages", () => {
  it("separates internal and external review, in order", () => {
    const stages = run(base({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(2) }, { kind: "USER", ref: "outsider", requestedAt: t(3) }] }), []);
    expect(stages.map((s) => s.stage)).toEqual(["INTERNAL_REVIEW", "EXTERNAL_REVIEW"]);
    expect(stages[0].owners).toEqual(["teammate"]);
    expect(stages[1].owners).toEqual(["outsider"]);
  });

  it("an approval completes review but does NOT satisfy a separate maintainer-merge stage", () => {
    const input = base({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(2) }], reviews: [{ reviewer: "teammate", state: "APPROVED", commitSha: "h1", submittedAt: t(5) }] });
    const none = run(input, []);
    expect(none).toEqual([]); // approved, and nothing else is awaited
    const stages = run(input, [rule({ stage: "MAINTAINER_MERGE" })]);
    expect(stages.map((s) => s.stage)).toEqual(["MAINTAINER_MERGE"]);
    expect(stages[0].owners).toEqual(["maintainer"]);
    expect(stages[0].since).toEqual(t(5)); // the wait for the merge starts at the approval
    expect(stages[0].nextAction).toMatch(/reviews are done/);
  });

  it("the merge stage is still waiting while reviews are outstanding, and counts from when the PR was ready", () => {
    const stages = run(base({ requests: [{ kind: "USER", ref: "teammate", requestedAt: t(2) }] }), [rule({ stage: "MAINTAINER_MERGE" })]);
    expect(stages.map((s) => s.stage)).toEqual(["INTERNAL_REVIEW", "MAINTAINER_MERGE"]);
    expect(stages[1].since).toEqual(t(0));
    expect(stages[1].nextAction).toMatch(/once reviews are done/);
  });

  it("a person named by a stage rule is not also listed as a plain reviewer", () => {
    const input = base({ requests: [{ kind: "USER", ref: "outsider", requestedAt: t(2) }] });
    const stages = run(input, [rule({ stage: "MAINTAINER_MERGE", waitingOn: [{ kind: "USER", ref: "outsider" }] })]);
    expect(stages.map((s) => s.stage)).toEqual(["MAINTAINER_MERGE"]);
  });

  it("an upstream-release record outlives the merge; other manual stages end with the PR", () => {
    const manual = [
      { stage: "UPSTREAM_RELEASE", reviewerKind: "EXTERNAL_ROLE", reviewerRef: "upstream", reason: "ships on the 1.4 train", startedAt: t(8), status: "PENDING", source: "MANUAL" },
      { stage: "MAINTAINER_MERGE", reviewerKind: "USER", reviewerRef: "bob", reason: "x", startedAt: t(8), status: "PENDING", source: "MANUAL" },
    ];
    const merged = run(base({ state: "MERGED" }), [], manual);
    expect(merged.map((s) => s.stage)).toEqual(["UPSTREAM_RELEASE"]);
    const open = run(base(), [], manual);
    expect(open.map((s) => s.stage)).toEqual(["MAINTAINER_MERGE", "UPSTREAM_RELEASE"]);
  });

  it("ignores cleared records and unknown stage names", () => {
    const manual = [
      { stage: "UPSTREAM_RELEASE", reviewerKind: "USER", reviewerRef: "a", reason: "x", startedAt: t(1), status: "SATISFIED", source: "MANUAL" },
      { stage: "nonsense", reviewerKind: "USER", reviewerRef: "a", reason: "x", startedAt: t(1), status: "PENDING", source: "MANUAL" },
    ];
    expect(run(base(), [], manual)).toEqual([]);
  });
});
