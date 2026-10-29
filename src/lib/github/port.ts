import type { RepoMeta } from "@/lib/services/repositories";
import type { CompareOutcome } from "@/lib/domain/forks";

/**
 * The seam between Mergeport and GitHub. The Octokit adapter and the demo adapter implement the same
 * contract, so demo mode exercises the same code paths as connected mode. Neither may fabricate data
 * when the other is unavailable: callers get a typed GithubError and render a limited/stale state.
 */

export type GithubErrorKind = "rate-limited" | "not-found" | "forbidden" | "auth" | "sso" | "network" | "unknown";

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly resetAt?: Date,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type RemoteLabel = { name: string; color: string };

export type RemoteWorkItem = {
  githubId: bigint;
  number: number;
  type: "ISSUE" | "PULL_REQUEST";
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  authorLogin: string | null;
  authorGithubId: bigint | null;
  authorAvatar: string | null;
  labels: RemoteLabel[];
  assignees: string[];
  milestoneNumber: number | null;
  milestoneTitle: string | null;
  htmlUrl: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  // PR-only (filled by getPull)
  headSha?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
};

export type RemoteReview = { githubId: bigint; login: string | null; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; body: string | null; commitSha: string | null; submittedAt: Date };
export type RemoteComment = { githubId: bigint; login: string | null; body: string | null; createdAt: Date; updatedAt: Date; path?: string | null; line?: number | null; commitSha?: string | null; threadKey?: string | null };
export type RemoteRequested = { users: string[]; teams: string[] };
export type RemoteFile = { filename: string; status: string; additions: number; deletions: number; patch: string | null };
export type RemoteCommit = { sha: string; message: string; author: string | null; date: Date | null };
export type RemoteBranch = { name: string; sha: string; isDefault: boolean };

export type Page<T> = { items: T[]; nextPage: number | null; rate?: RateInfo };
export type RateInfo = { remaining: number; limit: number; resetAt: Date };

export type DiscoveryNote = { kind: "additional-authorization" | "org-approval" | "not-available"; ownerLogin: string; message: string; actionUrl?: string };
export type Discovery = { repos: RepoMeta[]; nextPage: number | null; notes: DiscoveryNote[] };

export type MergeMethod = "merge" | "squash" | "rebase";

export interface GithubPort {
  readonly mode: "live" | "demo";
  /** Last rate-limit observation from this client, if any. */
  lastRate(): RateInfo | null;

  getRepository(owner: string, repo: string): Promise<RepoMeta>;
  listAuthorizedRepositories(page: number): Promise<Discovery>;

  listIssuesAndPulls(owner: string, repo: string, o: { since?: Date; page: number }): Promise<Page<RemoteWorkItem>>;
  getPull(owner: string, repo: string, number: number): Promise<RemoteWorkItem>;
  listReviews(owner: string, repo: string, number: number): Promise<RemoteReview[]>;
  listIssueComments(owner: string, repo: string, number: number): Promise<RemoteComment[]>;
  listReviewComments(owner: string, repo: string, number: number): Promise<RemoteComment[]>;
  listRequestedReviewers(owner: string, repo: string, number: number): Promise<RemoteRequested>;
  getChecksState(owner: string, repo: string, sha: string): Promise<"NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN">;
  listBranches(owner: string, repo: string): Promise<RemoteBranch[]>;
  /** Bounded: at most 300 files / 250 commits; callers show a truncation notice. */
  listPullFiles(owner: string, repo: string, number: number): Promise<{ files: RemoteFile[]; truncated: boolean }>;
  listPullCommits(owner: string, repo: string, number: number): Promise<{ commits: RemoteCommit[]; truncated: boolean }>;

  /** BASE = upstream branch, HEAD = fork branch. */
  compare(upstream: { owner: string; repo: string; branch: string }, fork: { owner: string; branch: string }): Promise<CompareOutcome>;
  /** Is `sha` an ancestor of `branchTip` in `repo`'s network? */
  isAncestor(repo: { owner: string; repo: string }, sha: string, branchTip: string): Promise<"ancestor" | "not-ancestor" | "unknown">;
  getPullMergeSha(owner: string, repo: string, number: number): Promise<string | null>;

  // ---- writes: always with the ACTING USER's credential, never silently an administrator's ----
  createIssue(owner: string, repo: string, input: { title: string; body?: string; labels?: string[] }): Promise<RemoteWorkItem>;
  createComment(owner: string, repo: string, number: number, body: string): Promise<RemoteComment>;
  setLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
  setAssignees(owner: string, repo: string, number: number, assignees: string[]): Promise<void>;
  setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<void>;
  requestReviewers(owner: string, repo: string, number: number, reviewers: { users?: string[]; teams?: string[] }): Promise<void>;
  submitReview(owner: string, repo: string, number: number, input: { event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; body?: string; commitSha?: string }): Promise<void>;
  mergePull(owner: string, repo: string, number: number, input: { method: MergeMethod; expectedHeadSha: string }): Promise<{ merged: boolean; message: string }>;
  mergeUpstream(owner: string, repo: string, branch: string): Promise<{ result: "merged" | "fast-forward" | "up-to-date" | "conflict"; message: string }>;
}
