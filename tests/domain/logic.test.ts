import { describe, expect, it } from "vitest";
import { resolveRule, type RuleRow } from "@/lib/domain/rules";
import { classifyCompare, classifyUpstreamMerge, isComparisonStale } from "@/lib/domain/forks";
import { checkVersion, computeProgress, isOverdue, positionBetween, todayIn, wouldCreateCycle } from "@/lib/domain/planning";
import { parseStatus, parseWorktreeList } from "@/lib/domain/gitparse";
import { backoff, canSpend, shouldApplyUpdate } from "@/lib/domain/sync";

const rule = (o: Partial<RuleRow> & { id: string }): RuleRow => ({
  scope: "WORKSPACE",
  repositoryId: null,
  ownerLogin: null,
  projectId: null,
  labels: [],
  reviewers: [{ kind: "USER", ref: o.id }],
  semantics: "ANY",
  reason: "r",
  enabled: true,
  ...o,
});
const ctx = { repositoryId: "repo1", ownerLogin: "northwind", labels: ["needs-maintainer-review"], projectIds: ["pA", "pB"] };

describe("rule precedence", () => {
  it("repository override beats project, owner and workspace", () => {
    const res = resolveRule(
      [rule({ id: "ws" }), rule({ id: "own", scope: "OWNER", ownerLogin: "northwind" }), rule({ id: "pa", scope: "PROJECT", projectId: "pA" }), rule({ id: "repo", scope: "REPOSITORY", repositoryId: "repo1" })],
      ctx,
    );
    expect(res.kind === "rule" && res.rule.id).toBe("repo");
  });

  it("repo in two projects with different project rules is a conflict, not a silent pick", () => {
    const res = resolveRule([rule({ id: "pa", scope: "PROJECT", projectId: "pA" }), rule({ id: "pb", scope: "PROJECT", projectId: "pB" })], ctx);
    expect(res.kind).toBe("conflict");
  });

  it("an explicit project context resolves the conflict", () => {
    const res = resolveRule([rule({ id: "pa", scope: "PROJECT", projectId: "pA" }), rule({ id: "pb", scope: "PROJECT", projectId: "pB" })], { ...ctx, contextProjectId: "pB" });
    expect(res.kind === "rule" && res.rule.id).toBe("pb");
  });

  it("a repository override resolves a multi-project conflict", () => {
    const res = resolveRule([rule({ id: "pa", scope: "PROJECT", projectId: "pA" }), rule({ id: "pb", scope: "PROJECT", projectId: "pB" }), rule({ id: "r", scope: "REPOSITORY", repositoryId: "repo1" })], ctx);
    expect(res.kind === "rule" && res.rule.id).toBe("r");
  });

  it("labels filter rules; a labelled rule is more specific than an unlabelled one", () => {
    const res = resolveRule([rule({ id: "plain", scope: "REPOSITORY", repositoryId: "repo1" }), rule({ id: "labelled", scope: "REPOSITORY", repositoryId: "repo1", labels: ["Needs-Maintainer-Review"] })], ctx);
    expect(res.kind === "rule" && res.rule.id).toBe("labelled");
    expect(resolveRule([rule({ id: "x", labels: ["other"] })], ctx).kind).toBe("none");
  });

  it("disabled rules and unrelated owners are ignored", () => {
    expect(resolveRule([rule({ id: "o", scope: "OWNER", ownerLogin: "someone-else" }), rule({ id: "d", enabled: false })], ctx).kind).toBe("none");
  });
});

describe("fork comparison", () => {
  const ok = (status: "identical" | "ahead" | "behind" | "diverged", a: number, b: number, total = a + b, returned = total) =>
    classifyCompare({ kind: "ok", data: { status, ahead_by: a, behind_by: b, total_commits: total, commits_returned: returned, base_sha: "u", head_sha: "f" } });

  it("states direction: behind_by is what the fork is missing from upstream", () => {
    const v = ok("behind", 0, 3);
    expect(v.status).toBe("fork-behind");
    expect(v.missingUpstream).toBe(3);
    expect(v.forkAhead).toBe(0);
    expect(ok("ahead", 2, 0).status).toBe("fork-ahead");
    expect(ok("diverged", 2, 3).status).toBe("diverged");
    expect(ok("identical", 0, 0).status).toBe("identical");
  });

  it("flags truncation, unrelated histories, deleted branches and rate limits", () => {
    expect(ok("behind", 0, 400, 400, 250).truncated).toBe(true);
    expect(classifyCompare({ kind: "no-common-ancestor" }).status).toBe("unrelated");
    expect(classifyCompare({ kind: "not-found" }).status).toBe("unavailable");
    expect(classifyCompare({ kind: "forbidden" }).status).toBe("unavailable");
    expect(classifyCompare({ kind: "rate-limited" }).status).toBe("unknown");
  });

  it("is stale when either tip moved", () => {
    expect(isComparisonStale({ baseSha: "a", headSha: "b" }, { upstreamTip: "a", forkTip: "b" })).toBe(false);
    expect(isComparisonStale({ baseSha: "a", headSha: "b" }, { upstreamTip: "a2", forkTip: "b" })).toBe(true);
    expect(isComparisonStale({ baseSha: null, headSha: "b" }, { upstreamTip: "a", forkTip: "b" })).toBe(true);
  });
});

describe("upstream merged-PR evidence", () => {
  const s = { ancestry: "unknown" as const, patchEquivalentCommitsFound: false, titleOrNumberMatch: false, manualAck: false, mergeShaKnown: true };

  it("exact ancestry is the only exact evidence", () => {
    expect(classifyUpstreamMerge({ ...s, ancestry: "ancestor" }).evidence).toBe("ANCESTRY_EXACT");
  });
  it("a missing original SHA does not prove a cherry-picked fix is absent", () => {
    const r = classifyUpstreamMerge({ ...s, ancestry: "not-ancestor" });
    expect(r.evidence).toBe("NOT_DETECTED");
    expect(r.note).toMatch(/does not prove/);
  });
  it("patch equivalence is only ever 'possible'", () => {
    const r = classifyUpstreamMerge({ ...s, ancestry: "not-ancestor", patchEquivalentCommitsFound: true });
    expect(r.evidence).toBe("PATCH_EQUIVALENT_POSSIBLE");
    expect(r.note).toMatch(/not proven/);
  });
  it("matching titles or PR numbers are not evidence", () => {
    const r = classifyUpstreamMerge({ ...s, titleOrNumberMatch: true });
    expect(r.evidence).toBe("UNKNOWN");
    expect(r.note).toMatch(/not evidence/);
  });
  it("manual acknowledgement is labelled as human, not Git evidence", () => {
    expect(classifyUpstreamMerge({ ...s, manualAck: true }).evidence).toBe("MANUAL_ACK");
  });
  it("unknown merge sha is unknown, not 'not detected'", () => {
    expect(classifyUpstreamMerge({ ...s, ancestry: "not-ancestor", mergeShaKnown: false }).evidence).toBe("UNKNOWN");
  });
});

describe("planning logic", () => {
  it("progress counts each GitHub resource once and a closing PR is not a second task", () => {
    const p = computeProgress([
      { id: "c1", workItemId: "issue1", columnKey: "done" },
      { id: "c2", workItemId: "pr1", closesWorkItemId: "issue1", columnKey: "done" },
      { id: "c3", workItemId: null, columnKey: "ready" },
      { id: "c4", workItemId: "issue2", columnKey: "in-progress" },
      { id: "c5", workItemId: "issue2", columnKey: "done" },
    ]);
    expect(p.total).toBe(3);
    expect(p.done).toBe(1); // issue2 duplicates disagree -> not done
    expect(p.label).toBe("Visible work");
  });
  it("a zero-item milestone has no percentage", () => {
    expect(computeProgress([]).percent).toBeNull();
  });
  it("detects dependency cycles", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false);
    expect(wouldCreateCycle(edges, "a", "a")).toBe(true);
  });
  it("optimistic version check", () => {
    expect(checkVersion(3, 3)).toEqual({ ok: true, version: 4 });
    expect(checkVersion(4, 3)).toEqual({ ok: false, reason: "conflict" });
  });
  it("fractional positions", () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1, 3)).toBe(2);
    expect(positionBetween(null, 10)).toBeLessThan(10);
  });
  it("due dates are date-only: timezone cannot shift a deadline", () => {
    const due = new Date("2026-10-29T00:00:00Z");
    expect(isOverdue(due, "ready", "2026-10-29")).toBe(false);
    expect(isOverdue(due, "ready", "2026-10-30")).toBe(true);
    expect(isOverdue(due, "done", "2026-12-01")).toBe(false);
    const instant = new Date("2026-10-29T03:00:00Z");
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-10-28");
    expect(todayIn("Asia/Tokyo", instant)).toBe("2026-10-29");
  });
});

describe("git parsers", () => {
  it("parses worktree list with detached, locked and prunable entries", () => {
    const out = ["worktree /w/main", "HEAD aaa", "branch refs/heads/main", "", "worktree /w/feat", "HEAD bbb", "detached", "locked in use", "", "worktree /w/gone", "HEAD ccc", "branch refs/heads/old", "prunable gitdir file points to non-existent location", "", ""].join("\0");
    const w = parseWorktreeList(out);
    expect(w).toHaveLength(3);
    expect(w[0]).toMatchObject({ path: "/w/main", branch: "main", detached: false });
    expect(w[1]).toMatchObject({ detached: true, locked: true, lockedReason: "in use", branch: null });
    expect(w[2].prunable).toBe(true);
  });
  it("handles paths containing spaces and newlines", () => {
    const out = ["worktree /w/my repo\nweird", "HEAD aaa", "branch refs/heads/x", "", ""].join("\0");
    expect(parseWorktreeList(out)[0].path).toBe("/w/my repo\nweird");
  });
  it("summarises status as counts only", () => {
    const out = ["## main...origin/main [ahead 2, behind 1]", " M a.ts", "A  b.ts", "R  new.ts", "old.ts", "?? c.ts", "UU conflict.ts", ""].join("\0");
    const s = parseStatus(out);
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, staged: 2, unstaged: 1, untracked: 1, conflicted: 1, dirty: true });
  });
  it("detached HEAD and clean tree", () => {
    const s = parseStatus("## HEAD (no branch)\0");
    expect(s.branch).toBeNull();
    expect(s.dirty).toBe(false);
  });
});

describe("sync ordering", () => {
  it("rejects stale writes", () => {
    const existing = { updatedAtGh: new Date("2026-10-02T00:00:00Z") };
    expect(shouldApplyUpdate(existing, new Date("2026-10-01T00:00:00Z"))).toBe(false);
    expect(shouldApplyUpdate(existing, new Date("2026-10-02T00:00:00Z"))).toBe(true);
    expect(shouldApplyUpdate(null, new Date())).toBe(true);
  });
  it("backoff honours Retry-After and gives up", () => {
    expect(backoff(1, 5, 60).delayMs).toBe(60_000);
    expect(backoff(5, 5).giveUp).toBe(true);
    expect(backoff(2, 5).delayMs).toBe(20_000);
  });
  it("keeps a reserve of API budget", () => {
    const rl = { remaining: 10, limit: 60, resetAt: new Date(Date.now() + 60_000) };
    expect(canSpend(rl, 3, 5)).toBe(true);
    expect(canSpend(rl, 6, 5)).toBe(false);
    expect(canSpend({ ...rl, resetAt: new Date(Date.now() - 1) }, 100, 5)).toBe(true);
  });
});
