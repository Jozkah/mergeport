import type { Db } from "@/lib/db";
import { GithubAppError, InstallationGoneError, InstallationSuspendedError, RateLimitedError, githubApiBase, mintInstallationToken } from "./app-auth";
import { loadBoundInstallation, markInstallationState } from "./binding";
import type { BoundInstallation } from "./bound-installation";
import { maybePruneHttpCache } from "./cache-prune";
import { DemoPort } from "./demo";
import { GithubNotConnectedError, GithubWritesDisabledError } from "./hosted";
import { OctokitPort, createOctokit, type CacheStore } from "./octokit";
import { GithubError, type GithubPort, type RateInfo } from "./port";
import { githubAppFetch } from "./transport";

/**
 * ETag cache persisted in PublicCacheEntry (conditional requests answered 304 do not spend rate limit).
 *
 * `prefix` partitions the keys. The unprefixed keys are the shared, GLOBAL cache: only answers any caller may see (the public port). Everything fetched with an installation token is kept under `installationCachePrefix`,
 * so a private body can never be served to a request made with another credential.
 */
export function dbCache(db: Db, prefix = ""): CacheStore {
  return {
    async get(key) {
      const row = await db.publicCacheEntry.findUnique({ where: { key: prefix + key } });
      return row ? { etag: row.etag, body: row.body } : null;
    },
    async set(key, etag, body) {
      const bytes = Buffer.byteLength(JSON.stringify(body) ?? "");
      await db.publicCacheEntry.upsert({ where: { key: prefix + key }, create: { key: prefix + key, etag, body: body as object, bytes }, update: { etag, body: body as object, bytes, fetchedAt: new Date() } });
      await maybePruneHttpCache(db, bytes);
    },
  };
}

/** Cache key prefix of everything fetched with the token of one installation. */
export const installationCachePrefix = (installationId: bigint | string | number) => `inst:${installationId}:`;
/** Rate-limit budget key of one installation (GitHub's quota belongs to the installation token, shared by every workspace using it). */
export const installationBudgetKey = (installationId: bigint | string | number) => `installation:${installationId}`;

/**
 * A short-lived installation token for a binding the workspace proved, with GitHub's failures turned into what callers handle:
 * an uninstalled or suspended installation is recorded (for every workspace using it) and surfaces as "not connected", which jobs
 * finish without retrying; a rate limit and a network failure are the usual typed GithubErrors. The token is never put in a message.
 */
async function installationToken(db: Db, bound: BoundInstallation): Promise<string> {
  try {
    return (await mintInstallationToken(bound, { fetch: githubAppFetch() })).token;
  } catch (e) {
    if (e instanceof InstallationGoneError) {
      await markInstallationState(db, bound.installationId, "deleted");
      throw new GithubNotConnectedError();
    }
    if (e instanceof InstallationSuspendedError) {
      await markInstallationState(db, bound.installationId, "suspended");
      throw new GithubNotConnectedError();
    }
    if (e instanceof RateLimitedError) {
      const secs = e.retryAfterMs ? Math.max(30, Math.ceil(e.retryAfterMs / 1000)) : 60;
      throw new GithubError("rate-limited", "GitHub rate limit reached for the GitHub App.", secs, new Date(Date.now() + secs * 1000));
    }
    if (e instanceof GithubAppError) throw new GithubError(e.code === "unavailable" ? "network" : "auth", e.code === "unavailable" ? "Could not reach GitHub" : "The GitHub App is not set up correctly.");
    throw e;
  }
}

/** The installation-backed port of one binding: read-only (the App has read permissions only), cached under the installation's own key prefix. */
export async function installationPort(db: Db, bound: BoundInstallation, o: { baseUrl?: string; onRate?: (r: RateInfo) => void } = {}): Promise<OctokitPort> {
  const token = await installationToken(db, bound);
  return new OctokitPort(createOctokit(token, githubAppFetch(), o.baseUrl ?? githubApiBase()), { cache: dbCache(db, installationCachePrefix(bound.installationId)), onRate: o.onRate });
}

/** The binding that serves a repository: its own installation, if the workspace still has a usable proved binding to it. */
async function boundFor(db: Db, repo: { workspaceId: string; installationId: bigint | null }): Promise<BoundInstallation> {
  if (repo.installationId === null) throw new GithubNotConnectedError();
  const bound = await loadBoundInstallation(db, repo.workspaceId, repo.installationId);
  if (!bound) throw new GithubNotConnectedError();
  return bound;
}

/** Source repositories: demo store for demo repositories, otherwise the repository's installation (no binding: the typed not-connected error). */
export async function portForSync(db: Db, repositoryId: string, o: { onRate?: (r: RateInfo) => void } = {}): Promise<GithubPort | null> {
  const repo = await db.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) return null;
  if (repo.isDemo) return new DemoPort(db, "demo-sync");
  return installationPort(db, await boundFor(db, repo), { onRate: o.onRate });
}

/** Workspaces only read GitHub for now (the App holds read permissions), so a write to a real repository says so instead of failing at GitHub. */
export async function portForWrite(db: Db, user: { id: string; login: string }, repo: { isDemo: boolean }): Promise<GithubPort> {
  if (repo.isDemo) return new DemoPort(db, user.login);
  throw new GithubWritesDisabledError();
}

/** Public data without any credential: no private-repository consent involved, cached, rate-limit aware. */
export function publicPort(db: Db): GithubPort {
  return new OctokitPort(createOctokit(undefined), { cache: dbCache(db) });
}
