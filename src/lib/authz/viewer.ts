import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { validRepoGithubIds } from "@/lib/github/access-cache";
import { can, isAdminRole, type Role, type Subject } from "./roles";

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
  /** Null for people who signed in with email or OIDC and have not linked a GitHub account. */
  githubId: bigint | null;
  /**
   * The person's GitHub login, or null without a linked GitHub account. `login` is NOT that: for an email user it is the mailbox
   * local part, and "alice@x" must never inherit the reviews, requests or authored work of the GitHub user "alice". Everything that
   * matches a person against GitHub data (review queues, inbox, digest, review requests) uses this field.
   */
  githubLogin: string | null;
  /**
   * GitHub ids of the repositories of THIS workspace that GitHub says the person may read and that were checked recently (see
   * src/lib/github/access-cache.ts). Loaded once per request; empty for administrators (they see everything anyway) and for people
   * without a linked GitHub account. Optional so a hand-built viewer without it simply has no GitHub-derived access.
   */
  githubRepoIds?: bigint[];
  timezone: string;
  /** The workspace role (docs/roles.md). Read the policy through can(); do not compare strings in new code. */
  role: Role;
  /** OWNER or ADMIN. Kept for the many existing checks; derived from `role`. */
  isAdmin: boolean;
};

/** The policy subject of a viewer. A hand-built viewer without `role` (older tests, local tools) counts as ADMIN when isAdmin, else MEMBER. */
export function subjectOf(v: Partial<Pick<Viewer, "role" | "isAdmin">>): Subject {
  return { role: v.role ?? (v.isAdmin ? "ADMIN" : "MEMBER") };
}

export type Capability = "view" | "manageWork" | "review";

/**
 * Loads the caller for ONE workspace. `workspaceId` is the active workspace (see resolveActiveWorkspaceId); the user must be an
 * ACTIVE member of it, otherwise null. Without it the only accepted shortcut is a user with exactly one active membership:
 * several memberships and no choice is ambiguous and yields null rather than a guess.
 */
export async function loadViewer(db: Db, userId: string, workspaceId?: string | null, opts: { now?: Date } = {}): Promise<Viewer | null> {
  const where = { userId, status: "ACTIVE" as const };
  let m;
  if (workspaceId) {
    m = await db.member.findFirst({ where: { ...where, workspaceId }, include: { user: true } });
  } else {
    const all = await db.member.findMany({ where, include: { user: true }, take: 2, orderBy: { createdAt: "asc" } });
    m = all.length === 1 ? all[0] : null;
  }
  if (!m) return null;
  const isAdmin = isAdminRole(m.role);
  return {
    userId,
    memberId: m.id,
    workspaceId: m.workspaceId,
    login: m.user.login,
    githubId: m.user.githubId,
    // The linked account's login. Only a legacy local user (whose githubId came from `gh`, so there is no stored login) falls back to `login`.
    githubLogin: m.user.githubId === null ? null : (m.user.githubLogin ?? m.user.login),
    githubRepoIds: isAdmin || m.user.githubId === null ? [] : await validRepoGithubIds(db, userId, m.workspaceId, opts.now),
    timezone: m.user.timezone,
    role: m.role,
    isAdmin,
  };
}

/**
 * Filter for repositories this viewer may see. Use it in every query that touches repo-owned data.
 *
 * The rule, in one place (a hosted installation token sees everything the installation can access, so what a person may see is
 * decided here, never by GitHub's token): OWNER and ADMIN see every tracked repository of the workspace. Everyone else (MEMBER,
 * READER) sees a repository through EITHER of two additive routes:
 *  1. an explicit, unrevoked RepositoryGrant; or
 *  2. GitHub says they may read it: the repository is tracked through an installation (`installationId` set) and the viewer has a
 *     fresh GithubRepoAccess row for it (`viewer.githubRepoIds`, loaded by `loadViewer`; rows older than 30 minutes count for nothing).
 * A public repository is not visible by that fact alone, and a hand-built viewer without `githubRepoIds` has route 1 only. Untracked
 * (REMOVED) repositories are visible to nobody. Route 2 is read access only: changing things still needs a grant and a role that writes.
 *
 * The disjunction sits under `AND`, so a caller that spreads the result and adds its own `OR` (WorkListPage does) cannot replace it.
 * Do not spread it and then set `AND`: tests/github-access.test.ts scans for that.
 */
export function repoWhere(v: Viewer): Prisma.RepositoryWhereInput {
  const base: Prisma.RepositoryWhereInput = { workspaceId: v.workspaceId, trackingStatus: { not: "REMOVED" } };
  if (v.isAdmin) return base;
  const granted: Prisma.RepositoryWhereInput = { grants: { some: { memberId: v.memberId, revokedAt: null } } };
  const ids = v.githubRepoIds;
  if (!ids || ids.length === 0) return { ...base, ...granted };
  return { ...base, AND: [{ OR: [granted, { githubId: { in: ids }, installationId: { not: null } }] }] };
}

/** Same filter, for models that hold a `repository` relation (WorkItem, Branch, ...). */
export const viaRepo = (v: Viewer): { repository: Prisma.RepositoryWhereInput } => ({ repository: repoWhere(v) });

export async function visibleRepoIds(db: Db, v: Viewer): Promise<string[]> {
  const rows = await db.repository.findMany({ where: repoWhere(v), select: { id: true } });
  return rows.map((r) => r.id);
}

export function requireAdmin(v: Viewer): void {
  if (!can(subjectOf(v), "manageSpaces")) throw new ForbiddenError("Administrator only");
}

/** Blocks READER (and, with `spaceCanWrite: false`, a member whose access to the space is read-only). The guard every mutating action passes through. */
export function requireWrite(v: Partial<Pick<Viewer, "role" | "isAdmin">>, spaceCanWrite?: boolean): void {
  if (!can(subjectOf(v), "write", { spaceCanWrite })) throw new ForbiddenError(spaceCanWrite === false ? "You have read-only access to this space" : "Your role is read-only in this workspace");
}

/**
 * Throws NotFound (never Forbidden) when the repo is hidden, so hidden and nonexistent are indistinguishable.
 * Throws Forbidden only when the repo is visible but the capability is missing.
 */
export async function requireRepo(db: Db, v: Viewer, repositoryId: string, cap: Capability = "view") {
  const repo = await db.repository.findFirst({ where: { id: repositoryId, ...repoWhere(v) }, include: { owner: true } });
  if (!repo) throw new NotFoundError();
  if (cap === "view") return repo;
  requireWrite(v);
  if (v.isAdmin) return repo;
  const g = await db.repositoryGrant.findFirst({
    where: { memberId: v.memberId, repositoryId, revokedAt: null },
  });
  // Visible through GitHub's own answer but without a grant: the person may look, not change.
  if (!g) throw new ForbiddenError("You can see this repository but have no grant to change it");
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
  if (!can(subjectOf(v), "write")) return { view: true, manageWork: false, review: false };
  if (v.isAdmin) return { view: true, manageWork: true, review: true };
  const g = await db.repositoryGrant.findFirst({ where: { memberId: v.memberId, repositoryId, revokedAt: null } });
  const view = Boolean(g) || (await db.repository.count({ where: { id: repositoryId, ...repoWhere(v) } })) > 0;
  return { view, manageWork: Boolean(g?.canManageWork), review: Boolean(g?.canReview) };
}

/**
 * Access-space filter: a project is visible when it sits in the COMMON space (or in none) or in a RESTRICTED space the viewer is a
 * member of. Not even an admin sees into a restricted space they are not in (they can add themselves from the Spaces panel).
 */
export function accessSpaceWhere(v: Pick<Viewer, "memberId">): Prisma.ProjectWhereInput {
  return { OR: [{ accessSpaceId: null }, { accessSpace: { kind: "COMMON" } }, { accessSpace: { members: { some: { memberId: v.memberId ?? "" } } } }] };
}

/** Projects visible to this viewer: members need membership AND at least one visible repo; admin sees all. A restricted space hides its projects from everyone outside it. */
export function projectWhere(v: Viewer): Prisma.ProjectWhereInput {
  const base: Prisma.ProjectWhereInput = { workspaceId: v.workspaceId, AND: [accessSpaceWhere(v)] };
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
export async function assertProjectWritable(db: Db, v: Pick<Viewer, "workspaceId"> & Partial<Pick<Viewer, "memberId" | "role" | "isAdmin">>, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  // A caller that passes only a workspace (background code) has no person to check; everyone else is held to their role and their space ACL.
  if (v.role !== undefined || v.isAdmin !== undefined) requireWrite(v);
  const p = await db.project.findUnique({ where: { id: projectId, workspaceId: v.workspaceId }, select: { spaceId: true, accessSpace: { select: { kind: true, members: { where: { memberId: v.memberId ?? "" }, select: { canWrite: true } } } } } });
  if (p?.accessSpace?.kind === "RESTRICTED" && v.memberId) requireWrite(v, p.accessSpace.members[0]?.canWrite === true);
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
