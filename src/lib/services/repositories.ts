import type { Prisma } from "@/generated/prisma/client";
import { refreshHubWatch } from "@/lib/hub/watch";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireAdmin, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { isHosted } from "@/lib/public-url";
import { purgeDigests } from "./digest-purge";
import { audit } from "./audit";

/** Canonical repository metadata as returned by GitHub (or the demo adapter). IDs are immutable GitHub ids. */
export type RepoMeta = {
  githubId: bigint;
  fullName: string;
  name: string;
  htmlUrl: string;
  description?: string | null;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN";
  isFork: boolean;
  parentGithubId?: bigint | null;
  parentFullName?: string | null;
  defaultBranch: string | null;
  archived: boolean;
  owner: { githubId: bigint; login: string; type: "USER" | "ORGANIZATION" | "UNKNOWN"; avatarUrl?: string | null };
  permissions?: Record<string, boolean> | null;
};

type Tx = Db | Prisma.TransactionClient;

/**
 * Upsert by immutable GitHub id: a rename or transfer updates the same row, and the same repository reached twice
 * (tracked locally, then received from a space) resolves to ONE row.
 */
export async function upsertRepository(tx: Tx, workspaceId: string, m: RepoMeta, extra: { isDemo?: boolean; syntheticOwner?: boolean; /** false: an existing (even untracked) row keeps its tracking status. */ reactivate?: boolean } = {}) {
  const owner = await tx.githubOwner.upsert({
    where: { githubId: m.owner.githubId },
    create: { githubId: m.owner.githubId, login: m.owner.login, type: m.owner.type, avatarUrl: m.owner.avatarUrl ?? null, synthetic: !!extra.syntheticOwner },
    update: { login: m.owner.login, type: m.owner.type, avatarUrl: m.owner.avatarUrl ?? null },
  });
  const data = {
    ownerId: owner.id,
    name: m.name,
    fullName: m.fullName,
    htmlUrl: m.htmlUrl,
    description: m.description ?? null,
    visibility: m.visibility,
    isFork: m.isFork,
    parentGithubId: m.parentGithubId ?? null,
    parentFullName: m.parentFullName ?? null,
    defaultBranch: m.defaultBranch,
    archived: m.archived,
    permissions: (m.permissions ?? undefined) as Prisma.InputJsonValue | undefined,
  };
  return tx.repository.upsert({
    where: { workspaceId_githubId: { workspaceId, githubId: m.githubId } },
    create: { workspaceId, githubId: m.githubId, isDemo: !!extra.isDemo, ...data },
    update: { ...data, ...(extra.reactivate === false ? {} : { trackingStatus: "ACTIVE" as const }) },
  });
}

/**
 * Tracks repositories on THIS computer for this person. It neither grants any GitHub access nor publishes anything to
 * teammates (that is the separate "Share to a space" step). The person gets full local capabilities on their own tracking.
 */
export async function trackLocally(db: Db, v: Viewer, metas: RepoMeta[]) {
  // Hosted: tracking is an administrator's decision and never grants anyone anything (docs/roles.md): no grant is created or revived,
  // and a repository an administrator untracked stays untracked until they connect it again on purpose.
  const hosted = isHosted();
  if (hosted) requireAdmin(v);
  const out = [];
  for (const m of metas) {
    const r = await upsertRepository(db, v.workspaceId, m, { reactivate: !hosted });
    if (!v.isAdmin && !hosted) {
      await db.repositoryGrant.upsert({
        where: { memberId_repositoryId: { memberId: v.memberId, repositoryId: r.id } },
        create: { memberId: v.memberId, repositoryId: r.id, grantedById: v.userId, canManageWork: true, canReview: true },
        update: { revokedAt: null },
      });
    }
    out.push(r);
  }
  await audit(db, v, "repository.track", undefined, { githubIds: metas.map((m) => m.githubId.toString()) });
  refreshHubWatch();
  return out;
}

/**
 * Stop tracking. For a shared repository this also needs write access to its space (the removal is shared as a deletion).
 * Grants are revoked in the same transaction, so re-tracking never silently restores old access.
 */
export async function removeFromTracking(db: Db, v: Viewer, repositoryId: string) {
  if (isHosted()) requireAdmin(v); // untracking revokes everyone's access: not a member's call (the local app has one person)
  const repo = await requireRepo(db, v, repositoryId, "view");
  const holders = await db.repositoryGrant.findMany({ where: { repositoryId: repo.id, revokedAt: null }, select: { member: { select: { userId: true } } } });
  if (repo.spaceId) {
    const space = await db.space.findUnique({ where: { id: repo.spaceId, workspaceId: v.workspaceId } });
    if (!space?.canWrite) throw new ValidationError("This repository is shared through a space you can only read, so it cannot be removed here.");
  }
  const now = new Date();
  await db.$transaction([
    db.repository.update({ where: { id: repo.id, workspaceId: v.workspaceId }, data: { trackingStatus: "REMOVED" } }),
    db.repositoryGrant.updateMany({ where: { repositoryId: repo.id, revokedAt: null }, data: { revokedAt: now } }),
    db.deviceRepoMapping.deleteMany({ where: { repositoryId: repo.id } }),
    db.worktreeSnapshot.deleteMany({ where: { repositoryId: repo.id } }),
  ]);
  await purgeDigests(db, v.workspaceId, holders.map((h) => h.member.userId));
  await audit(db, v, "repository.untrack", { type: "Repository", id: repositoryId });
  refreshHubWatch();
}

/**
 * Explicitly publishes a locally tracked repository (its identity: name, owner, visibility, default branch) to ONE
 * coordination space. Everyone with access to that space will see it. Needs write access to the space.
 */
export async function shareRepositoryToSpace(db: Db, v: Viewer, repositoryId: string, spaceId: string) {
  const repo = await requireRepo(db, v, repositoryId, "view");
  const space = await db.space.findUnique({ where: { id: spaceId, workspaceId: v.workspaceId } });
  if (!space || space.access !== "OK") throw new NotFoundError();
  if (!space.canWrite) throw new ValidationError("You only have read access to that space.");
  if (repo.spaceId && repo.spaceId !== space.id) throw new ValidationError("This repository is already shared through another space. A repository belongs to one audience.");
  const elsewhere = await db.project.count({ where: { workspaceId: v.workspaceId, spaceId: { not: null, notIn: [space.id] }, repositories: { some: { repositoryId: repo.id } } } });
  if (elsewhere) throw new ValidationError("A project shared through a different space links this repository. Unlink it there first.");
  await db.repository.update({ where: { id: repo.id, workspaceId: v.workspaceId }, data: { spaceId: space.id } });
  await audit(db, v, "repository.share", { type: "Repository", id: repo.id }, { space: space.name });
}

export async function unshareRepository(db: Db, v: Viewer, repositoryId: string) {
  const repo = await requireRepo(db, v, repositoryId, "view");
  if (!repo.spaceId) return;
  const space = await db.space.findUnique({ where: { id: repo.spaceId, workspaceId: v.workspaceId } });
  if (!space?.canWrite) throw new ValidationError("You only have read access to that space.");
  const linked = await db.project.count({ where: { workspaceId: v.workspaceId, spaceId: repo.spaceId, repositories: { some: { repositoryId: repo.id } } } });
  if (linked) throw new ValidationError("A project shared through that space still links this repository. Unlink it from the project first.");
  await db.repository.update({ where: { id: repo.id, workspaceId: v.workspaceId }, data: { spaceId: null } });
  await audit(db, v, "repository.unshare", { type: "Repository", id: repo.id });
}
