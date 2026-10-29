import type { Reviewer, ResolvedRule, Semantics } from "./review";

export type RuleRow = {
  id: string;
  scope: "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE";
  repositoryId: string | null;
  ownerLogin: string | null;
  projectId: string | null;
  labels: string[];
  reviewers: Reviewer[];
  semantics: Semantics;
  reason: string;
  enabled: boolean;
};

export type RuleContext = {
  repositoryId: string;
  ownerLogin: string;
  labels: string[];
  /** Projects containing the repository (only ones visible to the evaluator). */
  projectIds: string[];
  /** Explicit project context chosen by the user, if any. */
  contextProjectId?: string | null;
};

export type RuleResolution =
  | { kind: "none" }
  | { kind: "rule"; rule: Exclude<ResolvedRule, null> }
  | { kind: "conflict"; candidates: RuleRow[]; message: string };

const lc = (s: string) => s.toLowerCase();

/** An empty label list matches everything; otherwise at least one label must match (case-insensitive). */
export function labelsMatch(ruleLabels: string[], itemLabels: string[]): boolean {
  if (ruleLabels.length === 0) return true;
  const have = new Set(itemLabels.map(lc));
  return ruleLabels.some((l) => have.has(lc(l)));
}

const toResolved = (r: RuleRow, tier: string): Exclude<ResolvedRule, null> => ({ id: r.id, reviewers: r.reviewers, semantics: r.semantics, reason: r.reason, tier });

/**
 * Precedence: repository override > project rule > owner default > workspace default.
 * A repository in several projects with differing matching project rules is a configuration
 * conflict unless an explicit project context or a repository-level override resolves it.
 * Within one tier, a rule with labels is more specific than a label-less rule.
 */
export function resolveRule(rules: RuleRow[], ctx: RuleContext): RuleResolution {
  const live = rules.filter((r) => r.enabled && labelsMatch(r.labels, ctx.labels));
  const mostSpecific = (rs: RuleRow[]) => {
    const withLabels = rs.filter((r) => r.labels.length > 0);
    return withLabels.length ? withLabels : rs;
  };

  const repo = mostSpecific(live.filter((r) => r.scope === "REPOSITORY" && r.repositoryId === ctx.repositoryId));
  if (repo.length === 1) return { kind: "rule", rule: toResolved(repo[0], "repository override") };
  if (repo.length > 1) return { kind: "conflict", candidates: repo, message: "Several repository rules match the same labels" };

  const projectRules = live.filter((r) => r.scope === "PROJECT" && r.projectId && ctx.projectIds.includes(r.projectId));
  if (ctx.contextProjectId) {
    const scoped = mostSpecific(projectRules.filter((r) => r.projectId === ctx.contextProjectId));
    if (scoped.length === 1) return { kind: "rule", rule: toResolved(scoped[0], "project rule") };
    if (scoped.length > 1) return { kind: "conflict", candidates: scoped, message: "Several project rules match the same labels" };
  } else {
    const cand = mostSpecific(projectRules);
    const distinctProjects = new Set(cand.map((r) => r.projectId));
    if (distinctProjects.size === 1 && cand.length === 1) return { kind: "rule", rule: toResolved(cand[0], "project rule") };
    if (cand.length > 0) {
      return {
        kind: "conflict",
        candidates: cand,
        message: distinctProjects.size > 1 ? "This repository is in several projects with different review rules; choose a project context or add a repository override" : "Several project rules match the same labels",
      };
    }
  }

  const owner = mostSpecific(live.filter((r) => r.scope === "OWNER" && r.ownerLogin && lc(r.ownerLogin) === lc(ctx.ownerLogin)));
  if (owner.length === 1) return { kind: "rule", rule: toResolved(owner[0], "owner default") };
  if (owner.length > 1) return { kind: "conflict", candidates: owner, message: "Several owner rules match the same labels" };

  const ws = mostSpecific(live.filter((r) => r.scope === "WORKSPACE"));
  if (ws.length === 1) return { kind: "rule", rule: toResolved(ws[0], "workspace default") };
  if (ws.length > 1) return { kind: "conflict", candidates: ws, message: "Several workspace defaults match the same labels" };
  return { kind: "none" };
}
