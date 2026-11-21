import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { claimGap } from "@/lib/auth/rate-limit";
import { enqueue } from "@/lib/jobs";

/**
 * The cache of what GitHub says each person may open (docs/roles.md, docs/github-app.md "Linking your GitHub account"). One row per
 * person and repository (`GithubRepoAccess`), written only by the `github.access.refresh` job with THAT person's own token.
 *
 * The rule that makes this safe is the age check: a row grants access only while `checkedAt` is within VALID_FOR. A stale row, or no
 * row, grants nothing (fail closed) until the refresh job has run again. REFRESH_AFTER is when a page load or the scheduler asks for
 * a new check, so under normal use a row is renewed long before it would go stale.
 */
export const ACCESS_JOB = "github.access.refresh";
/** A person's data older than this is renewed (a page load or the scheduler enqueues the job; nothing waits for it). */
export const REFRESH_AFTER_MS = 10 * 60_000;
/** A row older than this grants nothing. */
export const VALID_FOR_MS = 30 * 60_000;
/** Permissions that mean "may read the repository", GitHub's own names. */
export const READ_PERMISSIONS = ["pull", "triage", "push", "maintain", "admin"] as const;
/** At most this many repositories are loaded into one request's viewer. */
export const MAX_VIEWER_REPO_IDS = 5000;
/** Page loads and the scheduler ask for a refresh at most this often per person. */
const ENQUEUE_GAP_MS = 60_000;

export const accessJobKey = (userId: string) => `ghaccess:${userId}`;

/**
 * The GitHub ids of the repositories of THIS workspace the person may read, according to GitHub and still fresh. The join to
 * Repository keeps the answer to this workspace's own installation-tracked repositories (and to the installation that serves each
 * one), so an access row obtained through another workspace's installation counts for nothing here. Not a list of everything the
 * person can open on GitHub.
 */
export async function validRepoGithubIds(db: Db, userId: string, workspaceId: string, now: Date = new Date()): Promise<bigint[]> {
  const cutoff = new Date(now.getTime() - VALID_FOR_MS);
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT a."repositoryGithubId" AS "id" FROM "GithubRepoAccess" a
    JOIN "Repository" r ON r."githubId" = a."repositoryGithubId" AND r."installationId" = a."installationId" AND r."workspaceId" = ${workspaceId}
    WHERE a."userId" = ${userId} AND a."checkedAt" >= ${cutoff} AND a."permission" IN ('pull', 'triage', 'push', 'maintain', 'admin') AND r."trackingStatus" <> 'REMOVED'
    ORDER BY a."repositoryGithubId" LIMIT ${MAX_VIEWER_REPO_IDS}`;
  return rows.map((r) => BigInt(r.id));
}

/** Queues the refresh job for this person (one job per person; a request while it runs makes it run again right after). */
export async function requestAccessRefresh(db: Db, userId: string): Promise<void> {
  await enqueue(db, { type: ACCESS_JOB, payload: { userId }, dedupeKey: accessJobKey(userId), workspaceId: null, maxAttempts: 3 });
}

/**
 * Called on a page load and by the scheduler: asks for a refresh when the person has a working link and their data is older than
 * REFRESH_AFTER. Never waits on GitHub, and at most once a minute per person even when the job keeps failing.
 */
export async function maybeRequestAccessRefresh(db: Db, userId: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.githubUserToken.findUnique({ where: { userId }, select: { status: true, accessCheckedAt: true } });
  if (!row || row.status !== "OK") return false;
  if (row.accessCheckedAt && now.getTime() - row.accessCheckedAt.getTime() < REFRESH_AFTER_MS) return false;
  if (!(await claimGap(db, `ghaccess:enqueue:${userId}`, ENQUEUE_GAP_MS, now))) return false;
  await requestAccessRefresh(db, userId);
  return true;
}

/**
 * A membership ended (removed, left): the person's cached access through installations of THAT workspace goes, unless they are
 * still an active member of another workspace that uses the same installation. Their stored digests are purged by the caller.
 */
export async function purgeAccessAfterMembershipEnd(tx: Db | Prisma.TransactionClient, userId: string, workspaceId: string): Promise<number> {
  const here = await tx.workspaceInstallation.findMany({ where: { workspaceId }, select: { installationId: true } });
  if (here.length === 0) return 0;
  const others = await tx.member.findMany({ where: { userId, status: "ACTIVE", workspaceId: { not: workspaceId } }, select: { workspaceId: true } });
  const keep = others.length === 0 ? [] : await tx.workspaceInstallation.findMany({ where: { workspaceId: { in: others.map((o) => o.workspaceId) } }, select: { installationId: true } });
  const keepIds = new Set(keep.map((k) => k.installationId));
  const drop = here.map((h) => h.installationId).filter((i) => !keepIds.has(i));
  if (drop.length === 0) return 0;
  return (await tx.githubRepoAccess.deleteMany({ where: { userId, installationId: { in: drop } } })).count;
}
