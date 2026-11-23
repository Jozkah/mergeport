import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
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
 * Tracks repositories in the workspace. It never grants any GitHub access. Outside a hosted deployment (the demo) a member gets full
 * capabilities on their own tracking.
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
  return out;
}

/**
 * Stop tracking. Grants are revoked in the same transaction, so re-tracking never silently restores old access.
 */
export async function removeFromTracking(db: Db, v: Viewer, repositoryId: string) {
  if (isHosted()) requireAdmin(v); // untracking revokes everyone's access: not a member's call (the local app has one person)
  const repo = await requireRepo(db, v, repositoryId, "manageWork");
  const holders = await db.repositoryGrant.findMany({ where: { repositoryId: repo.id, revokedAt: null }, select: { member: { select: { userId: true } } } });
  const now = new Date();
  await db.$transaction([
    db.repository.update({ where: { id: repo.id, workspaceId: v.workspaceId }, data: { trackingStatus: "REMOVED" } }),
    db.repositoryGrant.updateMany({ where: { repositoryId: repo.id, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  await purgeDigests(db, v.workspaceId, holders.map((h) => h.member.userId));
  await audit(db, v, "repository.untrack", { type: "Repository", id: repositoryId });
}
