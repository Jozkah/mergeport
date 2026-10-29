import type { ReviewDerivation } from "./review";
import type { StageEntry } from "./stages";

/**
 * One panel's worth of evidence for "is this ready to merge, and who acts next". Pure.
 *
 * Each row says what the evidence is and who stands behind it: GitHub reports a fact (checks, conflicts), the dashboard derives
 * advice (review routing, planning dependencies), or the information is not known here. Unknown is never shown as passing, and
 * advice is never presented as a rule GitHub enforces.
 */
export type ReadinessState = "ok" | "pending" | "blocked" | "unknown";
export type ReadinessRow = { key: "head" | "reviews" | "stale" | "checks" | "conflicts" | "dependencies" | "discussions"; label: string; state: ReadinessState; evidence: string; source: "github" | "dashboard" | "unknown" };
export type Readiness = { rows: ReadinessRow[]; ready: boolean; nextBy: string[]; nextAction: string };

export type ReadinessInput = {
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  authorLogin: string | null;
  headSha: string | null;
  checksState: "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  derivation: ReviewDerivation;
  stages: StageEntry[];
  dependencyBlockers: number;
};

export function deriveReadiness(i: ReadinessInput): Readiness {
  const d = i.derivation;
  const rows: ReadinessRow[] = [];
  rows.push({ key: "head", label: "Head commit", state: i.headSha ? "ok" : "unknown", evidence: i.headSha ? i.headSha.slice(0, 7) : "The head commit is not known yet", source: i.headSha ? "github" : "unknown" });

  const changes = d.actors.filter((a) => a.status === "CHANGES_REQUESTED");
  const pending = d.actors.filter((a) => a.status === "PENDING" || a.status === "UNAVAILABLE");
  const approved = d.actors.filter((a) => a.status === "APPROVED");
  rows.push({
    key: "reviews",
    label: "Reviews",
    state: !d.applicable ? "unknown" : changes.length ? "blocked" : pending.length ? "pending" : approved.length ? "ok" : "unknown",
    evidence: !d.applicable
      ? "No review request or routing rule applies, so the review state is unknown"
      : [approved.length ? `Approved on this commit: ${approved.map((a) => a.actor.ref).join(", ")}` : "", changes.length ? `Changes requested: ${changes.map((a) => a.actor.ref).join(", ")}` : "", pending.length ? `Still to review: ${pending.map((a) => a.actor.ref).join(", ")}` : ""].filter(Boolean).join(". "),
    source: "dashboard",
  });
  if (d.staleApprovals.length) rows.push({ key: "stale", label: "Stale approvals", state: "pending", evidence: `New commits since the approval of ${d.staleApprovals.join(", ")}`, source: "github" });

  rows.push({
    key: "checks",
    label: "Checks",
    state: i.checksState === "SUCCESS" ? "ok" : i.checksState === "FAILURE" ? "blocked" : i.checksState === "PENDING" ? "pending" : "unknown",
    evidence: { SUCCESS: "Checks pass", FAILURE: "A check is failing", PENDING: "Checks are still running", NONE: "No checks reported. Not necessarily none exist: absent is not the same as passing", UNKNOWN: "Checks could not be read with this account" }[i.checksState] + ". Which checks GitHub requires is not read here",
    source: "github",
  });
  rows.push({
    key: "conflicts",
    label: "Conflicts",
    state: i.mergeable === "MERGEABLE" ? "ok" : i.mergeable === "CONFLICTING" ? "blocked" : "unknown",
    evidence: i.mergeable === "MERGEABLE" ? "Merges cleanly" : i.mergeable === "CONFLICTING" ? "Conflicts with the base branch" : "GitHub has not computed mergeability yet",
    source: "github",
  });
  rows.push({ key: "dependencies", label: "Planning dependencies", state: i.dependencyBlockers > 0 ? "blocked" : "ok", evidence: i.dependencyBlockers > 0 ? `${i.dependencyBlockers} unfinished blocker${i.dependencyBlockers === 1 ? "" : "s"} in planning (dashboard advice, not a GitHub rule)` : "No unfinished blockers in planning", source: "dashboard" });
  rows.push({ key: "discussions", label: "Unresolved discussions", state: "unknown", evidence: "Whether review threads are resolved is not synchronised yet", source: "unknown" });

  const open = i.state === "OPEN" && !i.draft;
  const ready = open && rows.every((r) => r.state === "ok" || r.key === "discussions") && d.satisfied && i.stages.length === 0;

  // Who acts next, in the order work has to happen.
  let nextBy: string[] = [];
  let nextAction = "";
  const author = i.authorLogin ? [i.authorLogin] : [];
  if (i.state !== "OPEN") nextAction = i.state === "MERGED" ? "Merged" : "Closed";
  else if (i.draft) [nextBy, nextAction] = [author, "The author marks it ready for review"];
  else if (changes.length) [nextBy, nextAction] = [author, `The author answers the requested changes from ${changes.map((a) => a.actor.ref).join(", ")}`];
  else if (i.checksState === "FAILURE" || i.mergeable === "CONFLICTING") [nextBy, nextAction] = [author, i.checksState === "FAILURE" ? "The author fixes the failing checks" : "The author resolves the conflicts"];
  else if (i.dependencyBlockers > 0) [nextBy, nextAction] = [[], "Finish the blocking work in planning first"];
  else if (i.stages.length) [nextBy, nextAction] = [i.stages[0].owners, i.stages[0].nextAction];
  else if (ready) [nextBy, nextAction] = [[], "Ready: someone with merge rights can merge it"];
  else [nextBy, nextAction] = [[], "Nothing is known to be waiting. Check the rows above"];
  return { rows, ready, nextBy, nextAction };
}
