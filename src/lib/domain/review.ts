/**
 * Review-waiting derivation. Pure: no I/O, no clock (callers pass `now`).
 *
 * Review waiting is its own dimension. It is derived from real GitHub review requests and review
 * results plus the resolved routing rule. A comment, a label change or a removed label is NEVER
 * treated as an approval. Labels route attention (via the rule); they do not grant authority.
 */

export type ReviewerKind = "USER" | "TEAM" | "EXTERNAL_ROLE";
export type Reviewer = { kind: ReviewerKind; ref: string; display?: string };
export type Semantics = "ANY" | "ALL";

export type ResolvedRule = {
  id: string;
  reviewers: Reviewer[];
  semantics: Semantics;
  reason: string;
  tier: string;
} | null;

export type ReviewEvent = {
  reviewer: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commitSha: string | null;
  submittedAt: Date;
};
export type ReviewRequestRef = { kind: "USER" | "TEAM"; ref: string; requestedAt: Date };

export type ReviewInput = {
  type: "PULL_REQUEST" | "ISSUE";
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  authorLogin: string | null;
  headSha: string | null;
  checksState: "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviews: ReviewEvent[];
  requests: ReviewRequestRef[];
  /** Requests that were removed/cancelled. Only used to explain history. */
  cancelledRequests?: ReviewRequestRef[];
  rule: ResolvedRule;
  /** When the PR became reviewable (opened / marked ready). Used as the wait start when no request exists. */
  readyAt: Date;
  /** team slug -> member logins; null/undefined means the membership could not be read. */
  teamMembers?: Record<string, string[] | null>;
  /** Lowercased logins of dashboard members. Anyone else is external. */
  internalLogins: Set<string>;
  internalTeams?: Set<string>;
  /** External-role refs a person with authority explicitly cleared. */
  manuallyCleared?: Set<string>;
  blockedByDependencies?: number;
  now: Date;
};

export type ActorStatusKind = "APPROVED" | "APPROVED_STALE" | "CHANGES_REQUESTED" | "PENDING" | "UNAVAILABLE";

export type ActorStatus = {
  actor: Reviewer;
  status: ActorStatusKind;
  external: boolean;
  evidence: string;
  since: Date | null;
  sinceBasis: "request" | "ready" | null;
  /** True when this actor is only here because of an explicit GitHub review request (not the rule). */
  requestOnly: boolean;
};

export type PrimaryStatus =
  | "NOT_APPLICABLE"
  | "BLOCKED"
  | "CHANGES_REQUESTED"
  | "NEEDS_MY_REVIEW"
  | "WAITING_EXTERNAL"
  | "WAITING_TEAM"
  | "APPROVED"
  | "UNKNOWN";

export type ReviewDerivation = {
  applicable: boolean;
  satisfied: boolean;
  primary: PrimaryStatus;
  actors: ActorStatus[];
  queues: {
    needsMyReview: boolean;
    needsTeamReview: boolean;
    waitingExternal: boolean;
    changesRequestedForMe: boolean;
    blocked: boolean;
  };
  blockedReasons: string[];
  waiting: { since: Date; sinceBasis: "request" | "ready"; elapsedMs: number } | null;
  staleApprovals: string[];
  /** Human-readable explanation of why the item sits where it does. */
  explanation: string[];
};

const key = (r: { kind: string; ref: string }) => `${r.kind}:${r.kind === "EXTERNAL_ROLE" ? r.ref : r.ref.toLowerCase()}`;
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Latest effective review by a login. COMMENTED/PENDING reviews never count. DISMISSED cancels the previous one. */
export function effectiveReview(reviews: ReviewEvent[], login: string): ReviewEvent | null {
  const mine = reviews
    .filter((r) => lc(r.reviewer) === lc(login) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED"))
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  const last = mine[mine.length - 1];
  if (!last || last.state === "DISMISSED") return null;
  return last;
}

export function deriveReview(input: ReviewInput, viewerLogin: string): ReviewDerivation {
  const empty: ReviewDerivation = {
    applicable: false,
    satisfied: false,
    primary: "NOT_APPLICABLE",
    actors: [],
    queues: { needsMyReview: false, needsTeamReview: false, waitingExternal: false, changesRequestedForMe: false, blocked: false },
    blockedReasons: [],
    waiting: null,
    staleApprovals: [],
    explanation: [],
  };

  const blockedReasons: string[] = [];
  if (input.state === "OPEN") {
    if (input.checksState === "FAILURE") blockedReasons.push("Checks are failing");
    if (input.mergeable === "CONFLICTING") blockedReasons.push("Merge conflicts with the base branch");
    if ((input.blockedByDependencies ?? 0) > 0) blockedReasons.push(`Blocked by ${input.blockedByDependencies} unfinished dependenc${input.blockedByDependencies === 1 ? "y" : "ies"}`);
  }

  if (input.type !== "PULL_REQUEST" || input.state !== "OPEN") {
    return { ...empty, blockedReasons, queues: { ...empty.queues, blocked: blockedReasons.length > 0 } };
  }
  if (input.draft) {
    return {
      ...empty,
      blockedReasons,
      queues: { ...empty.queues, blocked: blockedReasons.length > 0 },
      explanation: ["Draft pull request: not ready for review, so it is in no review queue."],
    };
  }

  // Build the expected-actor list: rule reviewers plus explicitly requested reviewers.
  const byKey = new Map<string, { actor: Reviewer; requestOnly: boolean; request?: ReviewRequestRef }>();
  for (const r of input.rule?.reviewers ?? []) byKey.set(key(r), { actor: r, requestOnly: false });
  for (const rq of input.requests) {
    const k = key(rq);
    const existing = byKey.get(k);
    if (existing) existing.request = rq;
    else byKey.set(k, { actor: { kind: rq.kind, ref: rq.ref }, requestOnly: true, request: rq });
  }

  const author = lc(input.authorLogin);
  const actors: ActorStatus[] = [];
  const staleApprovals: string[] = [];
  const explanation: string[] = [];

  if (input.rule) explanation.push(`Rule (${input.rule.tier}): ${input.rule.reason}. ${input.rule.semantics === "ALL" ? "All listed reviewers" : "Any one listed reviewer"} must approve.`);

  for (const { actor, requestOnly, request } of byKey.values()) {
    const external = isExternal(actor, input);
    const mk = (status: ActorStatusKind, evidence: string): ActorStatus => ({
      actor,
      status,
      external,
      evidence,
      since: status === "PENDING" || status === "UNAVAILABLE" ? (request ? request.requestedAt : input.readyAt) : null,
      sinceBasis: status === "PENDING" || status === "UNAVAILABLE" ? (request ? "request" : "ready") : null,
      requestOnly,
    });

    if (actor.kind === "EXTERNAL_ROLE") {
      if (input.manuallyCleared?.has(actor.ref)) actors.push(mk("APPROVED", "Cleared by an authorized manual decision"));
      else actors.push(mk("PENDING", "No GitHub signal exists for this reviewer; needs an explicit manual decision"));
      continue;
    }

    if (actor.kind === "USER") {
      if (lc(actor.ref) === author) {
        // Authors cannot review their own PR; a rule naming the author is ignored (shown for clarity).
        explanation.push(`${actor.ref} is the author and cannot approve their own pull request.`);
        continue;
      }
      const eff = effectiveReview(input.reviews, actor.ref);
      const reRequested = Boolean(request && eff && request.requestedAt.getTime() > eff.submittedAt.getTime());
      if (eff && !reRequested) {
        const fresh = eff.commitSha !== null && input.headSha !== null && eff.commitSha === input.headSha;
        if (eff.state === "APPROVED") {
          if (fresh) actors.push(mk("APPROVED", `Approved ${eff.commitSha?.slice(0, 7)} at the current head`));
          else {
            staleApprovals.push(actor.ref);
            actors.push(mk("APPROVED_STALE", "Approval predates the latest commits; re-review needed"));
          }
        } else {
          actors.push(mk("CHANGES_REQUESTED", fresh ? "Requested changes on the current head" : "Requested changes earlier; not yet re-reviewed"));
        }
      } else if (reRequested) {
        actors.push(mk("PENDING", "Re-review requested after earlier review"));
      } else if (request) {
        actors.push(mk("PENDING", "GitHub review request is open"));
      } else {
        const cancelled = input.cancelledRequests?.find((c) => key(c) === key(actor));
        actors.push(mk("PENDING", cancelled ? "Review request was cancelled but the rule still requires this reviewer" : "Required by the routing rule; no review yet"));
      }
      continue;
    }

    // TEAM
    const members = input.teamMembers?.[actor.ref];
    if (!members) {
      actors.push(mk("UNAVAILABLE", `Team ${actor.ref} membership could not be read; cannot tell who may respond`));
      continue;
    }
    const memberStates = members.map((m) => ({ m, eff: effectiveReview(input.reviews, m) })).filter((x) => x.eff && lc(x.m) !== author);
    const cr = memberStates.find((x) => x.eff!.state === "CHANGES_REQUESTED");
    const ap = memberStates.find((x) => x.eff!.state === "APPROVED");
    if (cr) actors.push(mk("CHANGES_REQUESTED", `${cr.m} (team ${actor.ref}) requested changes`));
    else if (ap && ap.eff!.commitSha !== null && ap.eff!.commitSha === input.headSha) actors.push(mk("APPROVED", `${ap.m} (team ${actor.ref}) approved the current head`));
    else if (ap) {
      staleApprovals.push(ap.m);
      actors.push(mk("APPROVED_STALE", `${ap.m} (team ${actor.ref}) approved an earlier commit`));
    } else actors.push(mk("PENDING", request ? `Team ${actor.ref} was asked to review` : `Required by the routing rule; no review from team ${actor.ref} yet`));
  }

  const ruleActors = actors.filter((a) => !a.requestOnly);
  const requestOnlyActors = actors.filter((a) => a.requestOnly);
  const anyChanges = actors.some((a) => a.status === "CHANGES_REQUESTED");
  const approved = (a: ActorStatus) => a.status === "APPROVED";

  let ruleSatisfied: boolean;
  if (!input.rule) ruleSatisfied = true;
  else if (input.rule.semantics === "ALL") ruleSatisfied = ruleActors.length > 0 && ruleActors.every(approved);
  else ruleSatisfied = ruleActors.some(approved);

  const requestOnlySatisfied = requestOnlyActors.every(approved);
  const hasAnyDemand = actors.length > 0;
  const satisfied = hasAnyDemand && !anyChanges && ruleSatisfied && requestOnlySatisfied;

  // Which actors still block progress? With ANY semantics and the rule satisfied, other rule reviewers are optional.
  const ruleOptional = input.rule?.semantics === "ANY" && ruleSatisfied;
  const pendingActors = actors.filter((a) => (a.status === "PENDING" || a.status === "UNAVAILABLE" || a.status === "APPROVED_STALE") && !(ruleOptional && !a.requestOnly));

  const mineIsPending = pendingActors.some((a) => {
    if (a.actor.kind === "USER") return lc(a.actor.ref) === lc(viewerLogin);
    if (a.actor.kind === "TEAM") return (input.teamMembers?.[a.actor.ref] ?? []).some((m) => lc(m) === lc(viewerLogin));
    return false;
  }) || (staleApprovals.some((l) => lc(l) === lc(viewerLogin)) && !satisfied);

  const viewerIsAuthor = lc(viewerLogin) === author;
  const needsMyReview = !satisfied && !viewerIsAuthor && mineIsPending;
  const internalPending = pendingActors.some((a) => !a.external);
  const externalPending = pendingActors.some((a) => a.external);
  const changesRequestedForMe = anyChanges && viewerIsAuthor;
  const blocked = blockedReasons.length > 0;

  // Wait start = earliest pending actor start. Stale approvals restart from the latest head, which we only know via readyAt.
  const starts = pendingActors.map((a) => ({ at: a.since ?? input.readyAt, basis: a.sinceBasis ?? "ready" as const })).sort((a, b) => a.at.getTime() - b.at.getTime());
  const waiting = !satisfied && !anyChanges && starts.length > 0 ? { since: starts[0].at, sinceBasis: starts[0].basis, elapsedMs: Math.max(0, input.now.getTime() - starts[0].at.getTime()) } : null;

  let primary: PrimaryStatus;
  if (blocked) primary = "BLOCKED";
  else if (anyChanges) primary = "CHANGES_REQUESTED";
  else if (needsMyReview) primary = "NEEDS_MY_REVIEW";
  else if (externalPending && !internalPending) primary = "WAITING_EXTERNAL";
  else if (internalPending) primary = "WAITING_TEAM";
  else if (satisfied) primary = "APPROVED";
  else if (!hasAnyDemand) primary = "UNKNOWN";
  else primary = "UNKNOWN";

  if (!hasAnyDemand) explanation.push("No review request and no routing rule apply, so the review state is unknown.");
  if (pendingActors.some((a) => a.status === "UNAVAILABLE")) explanation.push("At least one expected reviewer could not be resolved; shown as unknown rather than approved.");
  if (staleApprovals.length) explanation.push(`New commits made earlier approvals stale: ${[...new Set(staleApprovals)].join(", ")}.`);

  return {
    applicable: true,
    satisfied,
    primary,
    actors,
    queues: {
      needsMyReview,
      needsTeamReview: !satisfied && !anyChanges && internalPending,
      waitingExternal: !satisfied && !anyChanges && externalPending,
      changesRequestedForMe,
      blocked,
    },
    blockedReasons,
    waiting,
    staleApprovals: [...new Set(staleApprovals)],
    explanation,
  };
}

export function isExternal(actor: Reviewer, input: ReviewInput): boolean {
  if (actor.kind === "EXTERNAL_ROLE") return true;
  if (actor.kind === "USER") return !input.internalLogins.has(lc(actor.ref));
  return !(input.internalTeams?.has(actor.ref) ?? false);
}
