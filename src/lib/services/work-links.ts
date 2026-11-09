import type { Db } from "@/lib/db";
import { requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { worktreesOnBranch, type LinkedWorktree } from "@/lib/domain/worktree-links";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireProject } from "@/lib/authz/viewer";
import { worktreesFor } from "./worktrees";
import { loadTask } from "./tasks";

/**
 * Connects the local worktree snapshot to the work it belongs to. A pull request is matched by repository and head branch; a task by
 * the branch name written on it (shared with the team) or by the pull request it follows. Matching is by name only and facts are
 * read from this computer's snapshot, so a teammate's checkout is never guessed at. Paths stay on this computer.
 */
export type WorkLinks = { machine: string | null; capturedAt: Date | null; stale: boolean; branch: string | null; matches: { repository: string; worktree: LinkedWorktree }[]; mapped: boolean };

async function across(db: Db, v: Viewer, repos: { id: string; fullName: string }[], branch: string | null): Promise<WorkLinks> {
  const matches: WorkLinks["matches"] = [];
  let machine: string | null = null;
  let capturedAt: Date | null = null;
  let stale = false;
  let mapped = false;
  for (const r of repos) {
    const view = await worktreesFor(db, v, r.id).catch(() => null);
    if (!view) continue;
    mapped = true;
    machine = view.machine;
    if (!capturedAt || view.capturedAt > capturedAt) capturedAt = view.capturedAt;
    stale = stale || view.stale;
    for (const w of worktreesOnBranch(view.worktrees as never, branch)) matches.push({ repository: r.fullName, worktree: w });
  }
  return { machine, capturedAt, stale, branch, matches, mapped };
}

export async function linksForPull(db: Db, v: Viewer, workItemId: string): Promise<WorkLinks> {
  const item = await requireWorkItem(db, v, workItemId);
  if (item.type !== "PULL_REQUEST") return { machine: null, capturedAt: null, stale: false, branch: null, matches: [], mapped: false };
  const repo = await db.repository.findUniqueOrThrow({ where: { id: item.repositoryId }, select: { id: true, fullName: true } });
  return across(db, v, [repo], item.headRef);
}

export async function linksForTask(db: Db, v: Viewer, taskId: string): Promise<WorkLinks> {
  const t = await loadTask(db, v, taskId);
  const linked = t.workItemId ? await db.workItem.findUnique({ where: { id: t.workItemId }, select: { headRef: true, repositoryId: true, type: true } }) : null;
  const branch = t.branchRef ?? (linked?.type === "PULL_REQUEST" ? linked.headRef : null);
  const repos = await db.repository.findMany({ where: { projects: { some: { projectId: t.projectId } }, ...(linked ? { id: linked.repositoryId } : {}) }, select: { id: true, fullName: true } });
  return across(db, v, repos, branch);
}

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

/** Writes the branch name on a task so it can be matched to a worktree. The name is shared with the team; no path is. */
export async function setTaskBranch(db: Db, v: Viewer, taskId: string, branch: string | null) {
  const t = await loadTask(db, v, taskId);
  await requireProject(db, v, t.projectId);
  const b = branch?.trim().replace(/^refs\/heads\//, "") || null;
  if (b && (!BRANCH.test(b) || b.includes(".."))) throw new ValidationError("That is not a branch name");
  if (!t) throw new NotFoundError();
  await db.planningItem.update({ where: { id: taskId }, data: { branchRef: b, version: { increment: 1 } } });
}

/** A path is only ever opened if it is one of this computer's own recorded worktrees for a repository the person can see. */
export async function knownWorktreePath(db: Db, v: Viewer, repositoryId: string, path: string): Promise<string> {
  const view = await worktreesFor(db, v, repositoryId);
  const hit = view?.worktrees.find((w) => w.path === path);
  if (!hit) throw new NotFoundError();
  return hit.path;
}
