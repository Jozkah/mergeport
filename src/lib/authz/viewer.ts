import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

/**
 * The authenticated, authorized caller. Loaded from the database on every request:
 * grants are never cached across requests, so revocation takes effect on the next call.
 * Repository visibility is expressed as a SQL filter (repoWhere) rather than a list held in
 * memory, so a revoked grant cannot be served from stale state.
 */
export type Viewer = {
  userId: string;
  memberId: string;
  workspaceId: string;
  login: string;
  githubId: bigint;
  timezone: string;
  isAdmin: boolean;
};

export type Capability = "view" | "manageWork" | "review";

/**
 * Loads the caller for ONE workspace. `workspaceId` is the active workspace (see resolveActiveWorkspaceId); the user must be an
 * ACTIVE member of it, otherwise null. Without it the only accepted shortcut is a user with exactly one active membership:
 * several memberships and no choice is ambiguous and yields null rather than a guess.
 */
export async function loadViewer(db: Db, userId: string, workspaceId?: string | null): Promise<Viewer | null> {
  const where = { userId, status: "ACTIVE" as const };
  let m;
  if (workspaceId) {
    m = await db.member.findFirst({ where: { ...where, workspaceId }, include: { user: true } });
  } else {
    const all = await db.member.findMany({ where, include: { user: true }, take: 2, orderBy: { createdAt: "asc" } });
    m = all.length === 1 ? all[0] : null;
  }
  if (!m) return null;
  return {
    userId,
    memberId: m.id,
    workspaceId: m.workspaceId,
    login: m.user.login,
    githubId: m.user.githubId,
    timezone: m.user.timezone,
    isAdmin: m.role === "ADMIN",
  };
}

/** Filter for repositories this viewer may see. Use it in every query that touches repo-owned data. */
export function repoWhere(v: Viewer): Prisma.RepositoryWhereInput {
  const base: Prisma.RepositoryWhereInput = { workspaceId: v.workspaceId, trackingStatus: { not: "REMOVED" } };
  if (v.isAdmin) return base;
  return { ...base, grants: { some: { memberId: v.memberId, revokedAt: null } } };
}

/** Same filter, for models that hold a `repository` relation (WorkItem, Branch, ...). */
export const viaRepo = (v: Viewer): { repository: Prisma.RepositoryWhereInput } => ({ repository: repoWhere(v) });

export async function visibleRepoIds(db: Db, v: Viewer): Promise<string[]> {
  const rows = await db.repository.findMany({ where: repoWhere(v), select: { id: true } });
  return rows.map((r) => r.id);
}

export function requireAdmin(v: Viewer): void {
  if (!v.isAdmin) throw new ForbiddenError("Administrator only");
}

/**
 * Throws NotFound (never Forbidden) when the repo is hidden, so hidden and nonexistent are indistinguishable.
 * Throws Forbidden only when the repo is visible but the capability is missing.
 */
export async function requireRepo(db: Db, v: Viewer, repositoryId: string, cap: Capability = "view") {
  const repo = await db.repository.findFirst({ where: { id: repositoryId, ...repoWhere(v) }, include: { owner: true } });
  if (!repo) throw new NotFoundError();
  if (v.isAdmin || cap === "view") return repo;
  const g = await db.repositoryGrant.findFirst({
    where: { memberId: v.memberId, repositoryId, revokedAt: null },
  });
  if (!g) throw new NotFoundError();
  if (cap === "manageWork" && !g.canManageWork) throw new ForbiddenError("Your grant does not include managing work");
  if (cap === "review" && !g.canReview) throw new ForbiddenError("Your grant does not include reviewing");
  return repo;
}

export async function requireWorkItem(db: Db, v: Viewer, workItemId: string, cap: Capability = "view") {
  const item = await db.workItem.findFirst({ where: { id: workItemId, ...viaRepo(v) } });
  if (!item) throw new NotFoundError();
  await requireRepo(db, v, item.repositoryId, cap);
  return item;
}

export async function capabilitiesFor(db: Db, v: Viewer, repositoryId: string): Promise<Record<Capability, boolean>> {
  if (v.isAdmin) return { view: true, manageWork: true, review: true };
  const g = await db.repositoryGrant.findFirst({ where: { memberId: v.memberId, repositoryId, revokedAt: null } });
  return { view: Boolean(g), manageWork: Boolean(g?.canManageWork), review: Boolean(g?.canReview) };
}

/** Projects visible to this viewer: members need membership AND at least one visible repo; admin sees all. */
export function projectWhere(v: Viewer): Prisma.ProjectWhereInput {
  const base: Prisma.ProjectWhereInput = { workspaceId: v.workspaceId };
  if (v.isAdmin) return base;
  return {
    ...base,
    members: { some: { memberId: v.memberId } },
    repositories: { some: { repository: repoWhere(v) } },
  };
}

export async function requireProject(db: Db, v: Viewer, projectId: string) {
  const p = await db.project.findFirst({ where: { id: projectId, ...projectWhere(v) } });
  if (!p) throw new NotFoundError();
  return p;
}

/**
 * A project shared into a space publishes its edits there, so a person whose own access to that space is read-only must not
 * make them: the edit would stay on this computer, never reach the team, and later show up as a merge nobody can resolve.
 * Local-only projects (no space) are always writable.
 */
export async function assertProjectWritable(db: Db, v: Pick<Viewer, "workspaceId">, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const p = await db.project.findUnique({ where: { id: projectId, workspaceId: v.workspaceId }, select: { spaceId: true } });
  if (!p?.spaceId) return;
  const space = await db.space.findUnique({ where: { id: p.spaceId, workspaceId: v.workspaceId }, select: { canWrite: true } });
  if (space && !space.canWrite) throw new ForbiddenError("This project is shared read-only with you");
}

/** requireProject plus the write check: visible first (hidden stays NotFound), then writable. */
export async function requireProjectWrite(db: Db, v: Viewer, projectId: string) {
  const p = await requireProject(db, v, projectId);
  await assertProjectWritable(db, v, p.id);
  return p;
}
