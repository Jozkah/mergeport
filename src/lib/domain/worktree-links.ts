/**
 * Connects the local branch/worktree snapshot to pull requests and tasks. Pure.
 * A match needs the same repository and the same branch name; nothing is guessed from titles. Paths stay on this computer: they are
 * part of the snapshot and are only ever shown to the person whose computer it is.
 */
export type Worktree = { path: string; branch: string | null; head: string | null; detached?: boolean; dirty?: { staged: number; unstaged: number; untracked: number }; tracking?: string | null; aheadBehind?: { ahead: number; behind: number } | null };

export type LinkedWorktree = { path: string; branch: string; head: string | null; dirty: { staged: number; unstaged: number; untracked: number } | null; ahead: number | null; behind: number | null; dirtyTotal: number | null };

const shape = (w: Worktree): LinkedWorktree => ({
  path: w.path,
  branch: w.branch ?? "",
  head: w.head,
  dirty: w.dirty ?? null,
  ahead: w.aheadBehind?.ahead ?? null,
  behind: w.aheadBehind?.behind ?? null,
  dirtyTotal: w.dirty ? w.dirty.staged + w.dirty.unstaged + w.dirty.untracked : null,
});

/** Worktrees of a repository whose checked-out branch is `branch`. Detached and unnamed worktrees never match. */
export function worktreesOnBranch(worktrees: Worktree[], branch: string | null | undefined): LinkedWorktree[] {
  if (!branch) return [];
  const b = branch.replace(/^refs\/heads\//, "");
  return worktrees.filter((w) => !w.detached && w.branch && w.branch.replace(/^refs\/heads\//, "") === b).map(shape);
}

/** A short statement of what the facts say, for beside the work item. Facts only, no advice. */
export function describeWorktree(w: LinkedWorktree): string {
  const parts: string[] = [];
  parts.push(w.dirtyTotal === null ? "changes unknown" : w.dirtyTotal === 0 ? "clean" : `${w.dirtyTotal} uncommitted change${w.dirtyTotal === 1 ? "" : "s"}`);
  if (w.ahead !== null && w.behind !== null) parts.push(w.ahead === 0 && w.behind === 0 ? "in step with its upstream" : `${w.ahead} ahead, ${w.behind} behind`);
  return parts.join(", ");
}
