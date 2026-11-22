import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { purgeDigests } from "@/lib/services/digest-purge";
import { GithubAppError } from "./app-auth";
import type { GithubAppConfig } from "./app-config";
import { listUserInstallationRepositories, listUserInstallations, getUser, type ConnectDeps, type GithubUser, type UserInstallationRepo } from "./connect-api";
import { connectOverrides } from "./connect";
import { MAX_VIEWER_REPO_IDS } from "./access-cache";
import { getUserAccessToken, markRelinkIfCurrent } from "./user-token";

/**
 * The `github.access.refresh` job body: asks GitHub, with THIS person's own token, which repositories they can open, and caches the
 * answer in GithubRepoAccess (src/lib/github/access-cache.ts explains how the cache is used and when it stops counting).
 *
 * Isolation: the function takes one user id, reads that person's token and writes only rows with that `userId`. Nothing it fetches
 * is stored for anyone else, and a token that turns out to belong to another GitHub account than the one linked is never used.
 *
 * Only installations that are bound to a workspace the person is an ACTIVE member of (and are neither suspended nor deleted) are
 * listed: an installation of some other account tells Mergeport nothing it may use. Rows are replaced for an installation only when
 * it was listed completely; a failed or cut-off listing leaves its rows to age out (fail closed), and `accessCheckedAt` then stays old
 * so the next trigger tries again.
 */
export type AccessRefreshResult = "ok" | "partial" | "none" | "relink" | "no-key" | "rate-limited" | "aborted";

/** A person may start this many refreshes in a window (each costs a handful of GitHub requests). */
export const USER_BUDGET_MAX = 12;
export const USER_BUDGET_WINDOW_MS = 10 * 60_000;
export const userBudgetKey = (userId: string) => `user:${userId}`;

export async function refreshUserAccess(db: Db, config: Pick<GithubAppConfig, "clientId" | "clientSecret">, userId: string, opts: { deps?: ConnectDeps; now?: Date } = {}): Promise<AccessRefreshResult> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? connectOverrides()?.deps ?? {};
  const user = await db.user.findUnique({ where: { id: userId }, select: { githubId: true, githubLogin: true } });
  if (!user || user.githubId === null) return "none";
  if (!(await take(db, userBudgetKey(userId), USER_BUDGET_MAX, USER_BUDGET_WINDOW_MS, now))) return "rate-limited";

  let t = await getUserAccessToken(db, config, userId, deps, now);
  if (t.kind !== "ok") return t.kind;
  let me: GithubUser | null = await getUser(deps, t.token);
  if (!me) {
    // GitHub refused a token we believed good (revoked, or expired early): one renewal, then the link needs a new sign-in.
    t = await getUserAccessToken(db, config, userId, deps, now, { force: true });
    if (t.kind !== "ok") return t.kind;
    me = await getUser(deps, t.token);
    if (!me) {
      await markRelinkIfCurrent(db, userId, t.version); // only the version this run used: a newer link is never touched
      return "relink";
    }
  }
  if (me.id !== user.githubId) {
    await markRelinkIfCurrent(db, userId, t.version); // this token is not the linked person's: never use it
    return "relink";
  }
  const token = t.token;
  const version = t.version;
  const gh: GithubUser = me;
  if (gh.login !== user.githubLogin) await db.user.updateMany({ where: { id: userId, githubId: gh.id }, data: { githubLogin: gh.login } });

  const memberships = await db.member.findMany({ where: { userId, status: "ACTIVE" }, select: { workspaceId: true } });
  const wsIds = memberships.map((m) => m.workspaceId);
  const boundRows = wsIds.length === 0 ? [] : await db.workspaceInstallation.findMany({ where: { workspaceId: { in: wsIds }, installation: { deletedAt: null, suspendedAt: null } }, select: { installationId: true } });
  const bound = [...new Set(boundRows.map((r) => r.installationId))];

  const listed = bound.length === 0 ? [] : await listUserInstallations(deps, token);
  if (listed === null) {
    await markRelinkIfCurrent(db, userId, version);
    return "relink";
  }
  const mine = new Set(listed.map((i) => i.id));

  // Per installation: the repositories GitHub shows this person, or a note that it could not be listed.
  const fresh = new Map<bigint, { repos: UserInstallationRepo[]; complete: boolean }>();
  let failed = false;
  for (const id of bound) {
    if (!mine.has(id)) {
      fresh.set(id, { repos: [], complete: true }); // GitHub does not show this installation to the person: no access through it
      continue;
    }
    try {
      fresh.set(id, (await listUserInstallationRepositories(deps, token, id)) ?? { repos: [], complete: true });
    } catch (e) {
      if (!(e instanceof GithubAppError)) throw e;
      failed = true; // its old rows stay and age out
    }
  }

  const outcome = await db.$transaction(
    async (tx) => {
      // The link must still be the one this run started from (not unlinked, not relinked to another account, not marked for relinking).
      const live = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GithubUserToken" WHERE "userId" = ${userId} AND "status" = 'OK' FOR UPDATE`;
      const u = await tx.user.findUnique({ where: { id: userId }, select: { githubId: true } });
      if (live.length === 0 || u?.githubId !== gh.id) return null;
      const before = await tx.githubRepoAccess.findMany({ where: { userId }, select: { repositoryGithubId: true } });
      const completeIds = [...fresh].filter(([, v]) => v.complete).map(([id]) => id);
      await tx.githubRepoAccess.deleteMany({ where: { userId, OR: [{ installationId: { notIn: bound } }, { installationId: { in: completeIds } }] } });
      const rows: { userId: string; repositoryGithubId: bigint; installationId: bigint; permission: string; checkedAt: Date }[] = [];
      for (const [installationId, v] of fresh) {
        if (!v.complete && v.repos.length > 0) await tx.githubRepoAccess.deleteMany({ where: { userId, installationId, repositoryGithubId: { in: v.repos.map((r) => r.id) } } });
        for (const r of v.repos) rows.push({ userId, repositoryGithubId: r.id, installationId, permission: r.permission, checkedAt: now });
      }
      for (let i = 0; i < rows.length; i += 1000) await tx.githubRepoAccess.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
      const after = new Set((await tx.githubRepoAccess.findMany({ where: { userId }, select: { repositoryGithubId: true } })).map((r) => r.repositoryGithubId));
      // The check counts as complete only when every listing succeeded. It is marked truncated when a listing hit its page cap or one person
      // has more repositories than a request can use (the Settings panel says so).
      const truncated = [...fresh.values()].some((v) => !v.complete) || after.size > MAX_VIEWER_REPO_IDS;
      if (!failed) await tx.githubUserToken.updateMany({ where: { userId }, data: { accessCheckedAt: now, accessTruncated: truncated, accessRepoCount: after.size } });
      if (truncated) console.warn("github access: a person's repository list was truncated");
      return { lost: before.filter((b) => !after.has(b.repositoryGithubId)).length };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  if (!outcome) return "aborted";
  // A stored digest is a snapshot of titles taken while the person could see a repository: when GitHub stops showing it, the snapshot goes.
  if (outcome.lost > 0) for (const ws of wsIds) await purgeDigests(db, ws, [userId]);
  return failed ? "partial" : "ok";
}
