import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireAdmin, type Viewer } from "@/lib/authz/viewer";
import { audit } from "./audit";

export type GrantCaps = { canManageWork?: boolean; canReview?: boolean };

async function memberIn(db: Db, admin: Viewer, memberId: string) {
  const m = await db.member.findFirst({ where: { id: memberId, workspaceId: admin.workspaceId, status: "ACTIVE" } });
  if (!m) throw new NotFoundError();
  return m;
}

/** Create-or-update grants for the listed repos. Every repo id is validated against the workspace. */
export async function grantRepositories(db: Db, admin: Viewer, memberId: string, repositoryIds: string[], caps: GrantCaps = {}) {
  requireAdmin(admin);
  const member = await memberIn(db, admin, memberId);
  if (member.role === "ADMIN") throw new ValidationError("Administrators already see every repository");
  const ids = [...new Set(repositoryIds)];
  const repos = await db.repository.findMany({
    where: { id: { in: ids }, workspaceId: admin.workspaceId, trackingStatus: { not: "REMOVED" } },
    select: { id: true },
  });
  if (repos.length !== ids.length) throw new ValidationError("One or more repositories are unknown");
  await db.$transaction(
    ids.map((repositoryId) =>
      db.repositoryGrant.upsert({
        where: { memberId_repositoryId: { memberId, repositoryId } },
        create: { memberId, repositoryId, grantedById: admin.userId, canManageWork: !!caps.canManageWork, canReview: !!caps.canReview },
        update: { revokedAt: null, canManageWork: !!caps.canManageWork, canReview: !!caps.canReview, grantedById: admin.userId },
      }),
    ),
  );
  await audit(db, admin, "grant.set", { type: "Member", id: memberId }, { repositoryIds: ids, ...caps });
}

export async function revokeRepositories(db: Db, admin: Viewer, memberId: string, repositoryIds: string[]) {
  requireAdmin(admin);
  await memberIn(db, admin, memberId);
  await db.repositoryGrant.updateMany({
    where: { memberId, repositoryId: { in: repositoryIds }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit(db, admin, "grant.revoke", { type: "Member", id: memberId }, { repositoryIds });
}

/** Step 1 of bulk assignment: what WOULD be granted. Nothing is written. */
export async function previewProjectAssignment(db: Db, admin: Viewer, projectId: string) {
  requireAdmin(admin);
  const p = await db.project.findFirst({
    where: { id: projectId, workspaceId: admin.workspaceId },
    include: { repositories: { include: { repository: true } } },
  });
  if (!p) throw new NotFoundError();
  return p.repositories.map((r) => ({ id: r.repository.id, fullName: r.repository.fullName, visibility: r.repository.visibility }));
}

/**
 * Step 2: apply. The caller must echo the exact repository ids they were shown; any drift
 * (a repo added to the project after the preview) fails instead of silently granting more.
 */
export async function assignProjectRepositories(db: Db, admin: Viewer, memberId: string, projectId: string, confirmedRepositoryIds: string[], caps: GrantCaps = {}) {
  const current = await previewProjectAssignment(db, admin, projectId);
  const a = [...new Set(confirmedRepositoryIds)].sort().join(",");
  const b = current.map((r) => r.id).sort().join(",");
  if (a !== b) throw new ValidationError("The project's repositories changed. Review the list and confirm again.");
  await grantRepositories(db, admin, memberId, current.map((r) => r.id), caps);
}
