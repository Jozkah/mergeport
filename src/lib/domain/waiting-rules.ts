import { isExternal, type ActorStatus, type ReviewDerivation, type ReviewInput, type Reviewer } from "./review";
import { labelsMatch } from "./rules";

/**
 * Waiting rules: "everything that matches waits on these people until it is merged or closed". They are data the person
 * writes (a repository, a GitHub owner, a project or the whole workspace; optional labels, authors, item type, drafts), never
 * built in. They add to the review derivation; they never remove a review requirement and never mark anything approved.
 */
export type WaitingRuleRow = {
  id: string;
  scope: "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE";
  repositoryId: string | null;
  ownerLogin: string | null;
  projectId: string | null;
  itemType: "PULL_REQUEST" | "ISSUE" | "ANY";
  labels: string[];
  authors: string[];
  includeDrafts: boolean;
  waitingOn: Reviewer[];
  reason: string;
  enabled: boolean;
};

export type WaitingContext = {
  repositoryId: string;
  ownerLogin: string;
  projectIds: string[];
  labels: string[];
  authorLogin: string | null;
  type: "PULL_REQUEST" | "ISSUE";
  draft: boolean;
};

const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

export function matchingWaitingRules(rules: WaitingRuleRow[], ctx: WaitingContext): WaitingRuleRow[] {
  return rules.filter((r) => {
    if (!r.enabled) return false;
    if (r.itemType !== "ANY" && r.itemType !== ctx.type) return false;
    if (ctx.draft && !r.includeDrafts) return false;
    if (r.scope === "REPOSITORY" && r.repositoryId !== ctx.repositoryId) return false;
    if (r.scope === "OWNER" && lc(r.ownerLogin) !== lc(ctx.ownerLogin)) return false;
    if (r.scope === "PROJECT" && !(r.projectId && ctx.projectIds.includes(r.projectId))) return false;
    if (r.authors.length > 0 && !r.authors.some((a) => lc(a) === lc(ctx.authorLogin))) return false;
    return labelsMatch(r.labels, ctx.labels);
  });
}

const key = (r: Reviewer) => `${r.kind}:${r.kind === "EXTERNAL_ROLE" ? r.ref : r.ref.toLowerCase()}`;

/**
 * Adds the people a matching rule says the work waits on. The author is a valid person to wait on (a maintainer who merges
 * their own pull request). The viewer is never "someone else", so rules naming the viewer add nothing to the others' queues.
 * Blocked and changes-requested states keep their priority; only an otherwise unknown or approved item takes the waiting status.
 */
export function applyWaitingRules(d: ReviewDerivation, input: ReviewInput, matched: WaitingRuleRow[], viewerLogin: string): ReviewDerivation {
  if (matched.length === 0 || input.state !== "OPEN") return d;
  const have = new Set(d.actors.map((a) => key(a.actor)));
  const added: ActorStatus[] = [];
  const targets: { external: boolean }[] = [];
  const lines: string[] = [];
  for (const rule of matched) {
    for (const actor of rule.waitingOn) {
      if (actor.kind === "USER" && lc(actor.ref) === lc(viewerLogin)) continue;
      // A person already in the review list (even one who approved) is still who the work waits on until it is merged.
      targets.push({ external: isExternal(actor, input) });
      if (have.has(key(actor))) continue;
      have.add(key(actor));
      added.push({ actor, status: "PENDING", external: isExternal(actor, input), evidence: rule.reason, since: input.readyAt, sinceBasis: "ready", requestOnly: false });
    }
    lines.push(`Waiting rule: ${rule.reason}. Waits on ${rule.waitingOn.map((a) => a.ref).join(", ")} until it is merged or closed.`);
  }
  if (targets.length === 0) return { ...d, explanation: [...d.explanation, ...lines] };
  const external = targets.some((t) => t.external);
  const internal = targets.some((t) => !t.external);
  const since = added.reduce((m, a) => (a.since && a.since < m ? a.since : m), input.readyAt);
  let primary = d.primary;
  if (primary === "UNKNOWN" || primary === "APPROVED" || primary === "NOT_APPLICABLE") primary = external && !internal ? "WAITING_EXTERNAL" : "WAITING_TEAM";
  return {
    ...d,
    applicable: true,
    primary,
    actors: [...d.actors, ...added],
    queues: { ...d.queues, waitingExternal: d.queues.waitingExternal || external, needsTeamReview: d.queues.needsTeamReview || internal },
    waiting: d.waiting ?? { since, sinceBasis: "ready", elapsedMs: Math.max(0, input.now.getTime() - since.getTime()) },
    explanation: [...d.explanation, ...lines],
  };
}
