import type { Db } from "@/lib/db";
import { audit } from "@/lib/services/audit";
import { makeBoundInstallation, type BoundInstallation } from "./bound-installation";
// markInstallationState (the only writer of suspendedAt/deletedAt for a loss) and listBoundInstallations are used by the factory and the connect flow.

/**
 * The only file that writes `Repository.installationId`, writes or deletes a `WorkspaceInstallation`, or issues a `BoundInstallation`
 * (tests/github-app-bindings.test.ts enforces the first and the last). The database backs this up: `Repository (workspaceId,
 * installationId)` is a composite foreign key to `WorkspaceInstallation`, so a repository can never name an installation its
 * workspace has not bound.
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
 * deleting a binding that repositories still reference), in one transaction with the audit record. Planning data is never touched.
 */
export async function unbindInstallation(db: Db, workspaceId: string, installationId: bigint, actorUserId: string | null = null): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const detached = await tx.repository.updateMany({ where: { workspaceId, installationId }, data: { installationId: null } });
    const r = await tx.workspaceInstallation.deleteMany({ where: { workspaceId, installationId } });
    if (r.count === 1) await audit(tx, { workspaceId, userId: actorUserId }, "github.disconnect", { type: "GithubInstallation", id: String(installationId) }, { repositoriesDetached: detached.count });
    return r.count === 1;
  });
}

/** What GitHub says about an installation (`GET /app/installations/:id`, signed with the app JWT). Public account facts only. */
export type InstallationFacts = {
  installationId: bigint;
  accountGithubId: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  repositorySelection: "ALL" | "SELECTED";
  suspendedAt: Date | null;
};

/** How control was proved: the GitHub user whose user-to-server token did it, and the method (for example `user-installations:org-admin`). */
export type InstallationProof = { githubUserId: bigint; method: string };

/**
 * The ONLY writer of a binding. Stores the installation's public facts (global row), creates the workspace's binding with its proof
 * and writes the audit record, in one transaction. Callers must have verified the proof already; this function does not talk to GitHub.
 * The same workspace and installation again is idempotent: the facts and the proof are refreshed, the original connector is kept, and
 * the audit record says so. A deleted mark is cleared (GitHub just answered for this installation); a suspended time follows GitHub.
 */
export async function bindInstallation(
  db: Db,
  input: { workspaceId: string; connectedByUserId: string; facts: InstallationFacts; proof: InstallationProof; now?: Date },
): Promise<{ created: boolean }> {
  // Two people connecting the same new installation at once can both miss it and then collide on a unique key (the global row, or the
  // workspace pair). The failed transaction is rolled back whole, so running it once more finds the winner's rows and takes the update path.
  try {
    return await bindOnce(db, input);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return bindOnce(db, input);
  }
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "P2002" || /unique constraint/i.test(String((e as { message?: unknown }).message ?? "")));

async function bindOnce(
  db: Db,
  input: { workspaceId: string; connectedByUserId: string; facts: InstallationFacts; proof: InstallationProof; now?: Date },
): Promise<{ created: boolean }> {
  const { workspaceId, connectedByUserId, facts, proof } = input;
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const data = { accountGithubId: facts.accountGithubId, accountLogin: facts.accountLogin, accountType: facts.accountType, repositorySelection: facts.repositorySelection, suspendedAt: facts.suspendedAt, deletedAt: null };
    await tx.githubInstallation.upsert({ where: { installationId: facts.installationId }, create: { installationId: facts.installationId, ...data }, update: data });
    const existing = await tx.workspaceInstallation.findFirst({ where: { workspaceId, installationId: facts.installationId }, select: { id: true } });
    if (existing) await tx.workspaceInstallation.updateMany({ where: { id: existing.id, workspaceId }, data: { verifiedAt: now, verifiedGithubUserId: proof.githubUserId, proofMethod: proof.method } });
    else await tx.workspaceInstallation.create({ data: { workspaceId, installationId: facts.installationId, connectedByUserId, verifiedAt: now, verifiedGithubUserId: proof.githubUserId, proofMethod: proof.method } });
    await audit(tx, { workspaceId, userId: connectedByUserId }, "github.connect", { type: "GithubInstallation", id: String(facts.installationId) }, { account: facts.accountLogin, accountType: facts.accountType, proof: proof.method, again: Boolean(existing) });
    return { created: !existing };
  });
}

/**
 * Refreshes the global facts of an installation from a fresh GitHub answer ("Check again"). Never creates a binding: callers have
 * already checked that the workspace has one.
 */
export async function refreshInstallationFacts(db: Db, facts: InstallationFacts): Promise<void> {
  await db.githubInstallation.updateMany({
    where: { installationId: facts.installationId },
    data: { accountGithubId: facts.accountGithubId, accountLogin: facts.accountLogin, accountType: facts.accountType, repositorySelection: facts.repositorySelection, suspendedAt: facts.suspendedAt, deletedAt: null },
  });
}

export type InstallationStatus = "active" | "suspended" | "removed";

/** The workspace's bindings with the installation's facts, newest first, for the settings page. */
export async function listWorkspaceInstallations(db: Db, workspaceId: string) {
  const rows = await db.workspaceInstallation.findMany({ where: { workspaceId }, include: { installation: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
  return rows.map((r) => ({
    installationId: r.installationId,
    accountLogin: r.installation.accountLogin,
    accountType: r.installation.accountType,
    repositorySelection: r.installation.repositorySelection,
    status: (r.installation.deletedAt ? "removed" : r.installation.suspendedAt ? "suspended" : "active") as InstallationStatus,
    connectedAt: r.createdAt,
  }));
}

/**
 * Every usable binding of the workspace (proved, installation neither suspended nor deleted), oldest first. The only way to get a
 * `BoundInstallation` for "all of this workspace's installations" (the connect page lists the repositories of each).
 */
export async function listBoundInstallations(db: Db, workspaceId: string): Promise<BoundInstallation[]> {
  const rows = await db.workspaceInstallation.findMany({ where: { workspaceId }, include: { installation: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.filter((r) => r.verifiedAt && !r.installation.suspendedAt && !r.installation.deletedAt).map((r) => makeBoundInstallation(r.installationId, r.workspaceId));
}

/**
 * Records what GitHub told us about an installation: uninstalled ("deleted"), suspended, or usable again ("active"). The row is global
 * (one installation, however many workspaces bound it), so every workspace sees the new state at once. Nothing else changes: bindings
 * and tracked repositories stay, and work again if the installation does.
 */
export async function markInstallationState(db: Db, installationId: bigint, state: "active" | "suspended" | "deleted", now = new Date()): Promise<boolean> {
  // A loss is recorded once (the first time stamp is kept); "active" clears both.
  const where = state === "active" ? { installationId } : state === "suspended" ? { installationId, suspendedAt: null } : { installationId, deletedAt: null };
  const data = state === "active" ? { suspendedAt: null, deletedAt: null } : state === "suspended" ? { suspendedAt: now } : { deletedAt: now };
  return (await db.githubInstallation.updateMany({ where, data })).count === 1;
}
