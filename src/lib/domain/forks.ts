/**
 * Fork / upstream classification. Pure.
 *
 * Direction is fixed and always stated: BASE = upstream branch, HEAD = fork branch
 * (`GET /repos/{upstream}/compare/{upstreamBranch}...{forkOwner}:{forkBranch}`).
 *   ahead_by  = commits the FORK has that the upstream lacks
 *   behind_by = commits the UPSTREAM has that the fork lacks  ("missing upstream commits")
 */

export type GithubCompare = {
  status: "identical" | "ahead" | "behind" | "diverged";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits_returned: number;
  base_sha: string;
  head_sha: string;
};

export type CompareOutcome =
  | { kind: "ok"; data: GithubCompare }
  | { kind: "not-found" } // deleted branch or inaccessible repo; GitHub does not distinguish
  | { kind: "no-common-ancestor" }
  | { kind: "forbidden" }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

export type ForkStatus = "identical" | "fork-ahead" | "fork-behind" | "diverged" | "unrelated" | "unavailable" | "unknown";

export type ForkComparisonView = {
  status: ForkStatus;
  forkAhead: number | null;
  missingUpstream: number | null;
  truncated: boolean;
  explanation: string;
};

export function classifyCompare(o: CompareOutcome): ForkComparisonView {
  switch (o.kind) {
    case "ok": {
      const d = o.data;
      const truncated = d.commits_returned < d.total_commits;
      const base = { forkAhead: d.ahead_by, missingUpstream: d.behind_by, truncated };
      const note = truncated ? " The commit list is truncated; counts are exact but not every commit is listed." : "";
      if (d.status === "identical") return { ...base, status: "identical", explanation: "Fork and upstream branches point at the same commit." };
      if (d.status === "ahead") return { ...base, status: "fork-ahead", explanation: `Fork is ${d.ahead_by} commit(s) ahead of upstream and is not missing any upstream commits.${note}` };
      if (d.status === "behind") return { ...base, status: "fork-behind", explanation: `Fork is missing ${d.behind_by} upstream commit(s).${note}` };
      return { ...base, status: "diverged", explanation: `Fork has ${d.ahead_by} commit(s) upstream lacks and is missing ${d.behind_by} upstream commit(s).${note}` };
    }
    case "no-common-ancestor":
      return { status: "unrelated", forkAhead: null, missingUpstream: null, truncated: false, explanation: "The branches share no history, so ahead/behind is not meaningful." };
    case "not-found":
      return { status: "unavailable", forkAhead: null, missingUpstream: null, truncated: false, explanation: "A mapped branch was deleted or a repository is not accessible to this connection. Remap the branches or check access." };
    case "forbidden":
      return { status: "unavailable", forkAhead: null, missingUpstream: null, truncated: false, explanation: "This connection lacks permission to compare these repositories." };
    case "rate-limited":
      return { status: "unknown", forkAhead: null, missingUpstream: null, truncated: false, explanation: "GitHub rate limit reached; showing the last known comparison if any." };
    default:
      return { status: "unknown", forkAhead: null, missingUpstream: null, truncated: false, explanation: `Comparison failed: ${o.message}` };
  }
}

/** A stored comparison is stale when either branch tip moved since it ran. */
export function isComparisonStale(stored: { baseSha: string | null; headSha: string | null }, current: { upstreamTip: string | null; forkTip: string | null }): boolean {
  if (!stored.baseSha || !stored.headSha || !current.upstreamTip || !current.forkTip) return true;
  return stored.baseSha !== current.upstreamTip || stored.headSha !== current.forkTip;
}

export type Evidence = "ANCESTRY_EXACT" | "PATCH_EQUIVALENT_POSSIBLE" | "MANUAL_ACK" | "NOT_DETECTED" | "UNKNOWN";

export type UpstreamMergeSignals = {
  /** Is the upstream merge commit an ancestor of the fork tip? Determined with a real compare, else 'unknown'. */
  ancestry: "ancestor" | "not-ancestor" | "unknown";
  /** Patch-id equivalence found by VERIFIED local Git data (git cherry). Never derived from titles. */
  patchEquivalentCommitsFound: boolean;
  titleOrNumberMatch: boolean;
  manualAck: boolean;
  mergeShaKnown: boolean;
};

export function classifyUpstreamMerge(s: UpstreamMergeSignals): { evidence: Evidence; note: string } {
  if (s.manualAck) return { evidence: "MANUAL_ACK", note: "Acknowledged manually; this is a human decision, not Git evidence." };
  if (s.ancestry === "ancestor") return { evidence: "ANCESTRY_EXACT", note: "The upstream merge commit is an ancestor of the fork branch." };
  if (s.patchEquivalentCommitsFound) return { evidence: "PATCH_EQUIVALENT_POSSIBLE", note: "Commits with equivalent patches exist locally; this may be a cherry-pick or rebase, but it is not proven." };
  if (s.ancestry === "unknown" || !s.mergeShaKnown) {
    return { evidence: "UNKNOWN", note: s.titleOrNumberMatch ? "Titles or PR numbers match, which is not evidence of the code being present." : "Ancestry could not be checked." };
  }
  return {
    evidence: "NOT_DETECTED",
    note: "The merge commit is not an ancestor of the fork branch and no equivalent patch was found. This does not prove the change is absent (it may have been re-implemented or cherry-picked without local data).",
  };
}
