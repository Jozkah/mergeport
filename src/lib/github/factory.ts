import type { Db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { DemoPort } from "./demo";
import { ghFetch } from "./gh";
import { profileRunner } from "@/lib/local/profile-runner";
import { OctokitPort, createOctokit, type CacheStore } from "./octokit";
import type { Discovery, GithubPort } from "./port";

/** ETag cache persisted in PublicCacheEntry (conditional requests answered 304 do not spend rate limit). */
export function dbCache(db: Db): CacheStore {
  return {
    async get(key) {
      const row = await db.publicCacheEntry.findUnique({ where: { key } });
      return row ? { etag: row.etag, body: row.body } : null;
    },
    async set(key, etag, body) {
      await db.publicCacheEntry.upsert({ where: { key }, create: { key, etag, body: body as object }, update: { etag, body: body as object, fetchedAt: new Date() } });
    },
  };
}

/**
 * The local person's own GitHub access, bound to this profile's account (see bound.ts). Used for sync, writes and
 * discovery. `signal` cancels every call made through the returned port.
 */
export function ghPort(db: Db, o: { signal?: AbortSignal; timeoutMs?: number } = {}): GithubPort {
  return new OctokitPort(createOctokit(undefined, ghFetch(profileRunner(db), undefined, o)), { cache: dbCache(db) });
}

/** Source repositories: demo store in demo mode, otherwise the person's gh credential. */
export async function portForSync(db: Db, repositoryId: string): Promise<GithubPort | null> {
  const repo = await db.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) return null;
  if (repo.isDemo) return new DemoPort(db, "demo-sync");
  return ghPort(db);
}

/** Writes are always made as the acting person: there is exactly one identity on a local installation. */
export async function portForWrite(db: Db, user: { id: string; login: string }, repo: { isDemo: boolean }): Promise<GithubPort> {
  if (repo.isDemo) return new DemoPort(db, user.login);
  return ghPort(db);
}

export async function portForDiscovery(db: Db, user: { id: string; login: string }, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GithubPort> {
  return isDemo() ? new DemoPort(db, user.login) : ghPort(db, o);
}

/** Public data without any credential: no private-repository consent involved, cached, rate-limit aware. */
export function publicPort(db: Db): GithubPort {
  return new OctokitPort(createOctokit(undefined), { cache: dbCache(db) });
}

/** Lists every page of discovery (bounded). */
export async function discoverAll(port: GithubPort, maxPages = 10): Promise<Discovery> {
  const all: Discovery = { repos: [], nextPage: null, notes: [] };
  for (let page = 1, i = 0; page && i < maxPages; i++) {
    const d = await port.listAuthorizedRepositories(page);
    all.repos.push(...d.repos);
    all.notes.push(...d.notes);
    page = d.nextPage ?? 0;
  }
  return all;
}
