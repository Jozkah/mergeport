import { describe, expect, it } from "vitest";
import { deriveReview, type ReviewInput } from "@/lib/domain/review";
import { applyWaitingRules, matchingWaitingRules, type WaitingRuleRow } from "@/lib/domain/waiting-rules";

const now = new Date("2026-10-29T12:00:00Z");
const input = (o: Partial<ReviewInput> = {}): ReviewInput => ({ type: "PULL_REQUEST", state: "OPEN", draft: false, authorLogin: "maintainer", headSha: "h", checksState: "SUCCESS", mergeable: "MERGEABLE", reviews: [], requests: [], rule: null, readyAt: new Date("2026-10-28T12:00:00Z"), internalLogins: new Set(["me"]), now, ...o });
const rule = (o: Partial<WaitingRuleRow> = {}): WaitingRuleRow => ({ id: "w1", scope: "OWNER", repositoryId: null, ownerLogin: "maintainer", projectId: null, itemType: "PULL_REQUEST", labels: [], authors: [], includeDrafts: false, waitingOn: [{ kind: "USER", ref: "maintainer" }], reason: "Globex merges everything here", enabled: true, ...o });
const ctx = (o = {}) => ({ repositoryId: "r1", ownerLogin: "maintainer", projectIds: ["p1"], labels: [] as string[], authorLogin: "maintainer", type: "PULL_REQUEST" as const, draft: false, ...o });

describe("matching", () => {
  it("matches by owner, repository, project and workspace, case-insensitively", () => {
    expect(matchingWaitingRules([rule()], ctx())).toHaveLength(1);
    expect(matchingWaitingRules([rule({ ownerLogin: "someone" })], ctx())).toHaveLength(0);
    expect(matchingWaitingRules([rule({ scope: "REPOSITORY", repositoryId: "r1" })], ctx())).toHaveLength(1);
    expect(matchingWaitingRules([rule({ scope: "REPOSITORY", repositoryId: "r2" })], ctx())).toHaveLength(0);
    expect(matchingWaitingRules([rule({ scope: "PROJECT", projectId: "p1" })], ctx())).toHaveLength(1);
    expect(matchingWaitingRules([rule({ scope: "PROJECT", projectId: "p2" })], ctx())).toHaveLength(0);
    expect(matchingWaitingRules([rule({ scope: "WORKSPACE" })], ctx())).toHaveLength(1);
  });
  it("honours item type, drafts, labels, authors and enabled", () => {
    expect(matchingWaitingRules([rule()], ctx({ type: "ISSUE" }))).toHaveLength(0);
    expect(matchingWaitingRules([rule({ itemType: "ANY" })], ctx({ type: "ISSUE" }))).toHaveLength(1);
    expect(matchingWaitingRules([rule()], ctx({ draft: true }))).toHaveLength(0);
    expect(matchingWaitingRules([rule({ includeDrafts: true })], ctx({ draft: true }))).toHaveLength(1);
    expect(matchingWaitingRules([rule({ labels: ["ready"] })], ctx({ labels: ["Ready"] }))).toHaveLength(1);
    expect(matchingWaitingRules([rule({ labels: ["ready"] })], ctx())).toHaveLength(0);
    expect(matchingWaitingRules([rule({ authors: ["me"] })], ctx())).toHaveLength(0);
    expect(matchingWaitingRules([rule({ enabled: false })], ctx())).toHaveLength(0);
  });
});

describe("applying", () => {
  it("puts the maintainer's own pull request in waiting-on-others, which a review rule alone never did", () => {
    const i = input();
    const plain = deriveReview(i, "me");
    expect(plain.queues.waitingExternal).toBe(false);
    const d = applyWaitingRules(plain, i, [rule()], "me");
    expect(d.queues.waitingExternal).toBe(true);
    expect(d.primary).toBe("WAITING_EXTERNAL");
    expect(d.actors.map((a) => a.actor.ref)).toEqual(["maintainer"]);
    expect(d.explanation.join(" ")).toMatch(/Globex merges everything here/);
  });
  it("keeps blocked priority but still lists the item as waiting", () => {
    const i = input({ checksState: "FAILURE" });
    const d = applyWaitingRules(deriveReview(i, "me"), i, [rule()], "me");
    expect(d.primary).toBe("BLOCKED");
    expect(d.queues.waitingExternal).toBe(true);
  });
  it("waits even when approved, until merged", () => {
    const i = input({ authorLogin: "me", reviews: [{ reviewer: "maintainer", state: "APPROVED", commitSha: "h", submittedAt: now }], rule: { id: "r", reviewers: [{ kind: "USER", ref: "maintainer" }], semantics: "ANY", reason: "x", tier: "t" } });
    const base = deriveReview(i, "me");
    expect(base.satisfied).toBe(true);
    expect(applyWaitingRules(base, i, [rule()], "me").queues.waitingExternal).toBe(true);
  });
  it("never counts the viewer as someone else, never duplicates an actor, and ignores closed items", () => {
    const i = input();
    expect(applyWaitingRules(deriveReview(i, "maintainer"), i, [rule()], "maintainer").queues.waitingExternal).toBe(false);
    const withRequest = input({ requests: [{ kind: "USER", ref: "maintainer", requestedAt: now }], authorLogin: "me" });
    expect(applyWaitingRules(deriveReview(withRequest, "me"), withRequest, [rule()], "me").actors).toHaveLength(1);
    const merged = input({ state: "MERGED" });
    expect(applyWaitingRules(deriveReview(merged, "me"), merged, [rule()], "me").queues.waitingExternal).toBe(false);
  });
  it("sends a teammate who is a dashboard member to team review instead", () => {
    const i = input({ internalLogins: new Set(["me", "maintainer"]) });
    const d = applyWaitingRules(deriveReview(i, "me"), i, [rule()], "me");
    expect(d.queues.needsTeamReview).toBe(true);
    expect(d.queues.waitingExternal).toBe(false);
  });
});
