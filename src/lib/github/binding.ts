import type { Db } from "@/lib/db";
import { makeBoundInstallation, type BoundInstallation } from "./bound-installation";

/**
 * The only file that writes `Repository.installationId` or issues a `BoundInstallation` (tests/github-app-bindings.test.ts enforces both).
 * The database backs this up: `Repository (workspaceId, installationId)` is a composite foreign key to `WorkspaceInstallation`, so a
 * repository can never name an installation its workspace has not bound.
 */

/**
 * The workspace's binding to an installation, if it exists, was proved (`verifiedAt` is NOT NULL: a row exists only once proved) and the
 * installation is neither suspended nor deleted. Null otherwise.
 */
export async function loadBoundInstallation(db: Db, workspaceId: string, installationId: bigint): Promise<BoundInstallation | null> {
  const row = await db.workspaceInstallation.findFirst({ where: { workspaceId, installationId }, include: { installation: true } });
  if (!row || !row.verifiedAt) return null;
  if (row.installation.suspendedAt || row.installation.deletedAt) return null;
  return makeBoundInstallation(row.installationId, row.workspaceId);
}

/** Points one repository of the workspace at an installation the workspace has bound (or at none, with null). Returns whether a row changed. */
export async function setRepositoryInstallation(db: Db, workspaceId: string, repositoryId: string, installationId: bigint | null): Promise<boolean> {
  if (installationId !== null) {
    const row = await db.workspaceInstallation.findFirst({ where: { workspaceId, installationId }, select: { id: true } });
    if (!row) throw new Error("The workspace has no binding to that installation.");
  }
  const r = await db.repository.updateMany({ where: { id: repositoryId, workspaceId }, data: { installationId } });
  return r.count === 1;
}

/**
 * Removes the workspace's binding. Repositories that name the installation are detached first (the foreign key does not allow
 * deleting a binding that repositories still reference), in one transaction.
 */
export async function unbindInstallation(db: Db, workspaceId: string, installationId: bigint): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.repository.updateMany({ where: { workspaceId, installationId }, data: { installationId: null } });
    const r = await tx.workspaceInstallation.deleteMany({ where: { workspaceId, installationId } });
    return r.count === 1;
  });
}
