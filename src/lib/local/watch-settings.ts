import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { WATCH_DEFAULT_SECONDS, WATCH_MAX_REPOS, WATCH_MAX_REPOS_LIMIT, WATCH_MAX_REPOS_MIN, WATCH_MAX_SECONDS, WATCH_MIN_SECONDS } from "@/lib/local/watch-format";

/**
 * Settings of the repository auto-sync watcher, per profile (TeamConfig). Precedence for the interval:
 * the value saved on the Settings page, else MERGEPORT_WATCH_SECONDS (valid values only), else 15.
 * A NULL column means "never saved here".
 */
export async function readWatchSettings(db: Db): Promise<{ enabled: boolean; seconds: number; maxRepos: number }> {
  const row = await db.teamConfig.findUnique({ where: { id: "team" }, select: { watchSeconds: true, watchEnabled: true, watchMaxRepos: true } });
  const fromEnv = env().MERGEPORT_WATCH_SECONDS ?? WATCH_DEFAULT_SECONDS;
  const seconds = Math.min(WATCH_MAX_SECONDS, Math.max(WATCH_MIN_SECONDS, row?.watchSeconds ?? fromEnv));
  const maxRepos = Math.min(WATCH_MAX_REPOS_LIMIT, Math.max(WATCH_MAX_REPOS_MIN, row?.watchMaxRepos ?? env().MERGEPORT_WATCH_MAX_REPOS ?? WATCH_MAX_REPOS));
  return { enabled: row?.watchEnabled ?? true, seconds, maxRepos };
}

/** A whole number from 2 to 300, or a plain sentence saying what is wrong. */
export function parseWatchSeconds(raw: unknown): number {
  const text = String(raw ?? "").trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < WATCH_MIN_SECONDS || n > WATCH_MAX_SECONDS) throw new ValidationError(`Enter a whole number of seconds from ${WATCH_MIN_SECONDS} to ${WATCH_MAX_SECONDS}.`);
  return n;
}

/** A whole number from 1 to 200, or a plain sentence saying what is wrong. */
export function parseWatchMaxRepos(raw: unknown): number {
  const text = String(raw ?? "").trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < WATCH_MAX_REPOS_MIN || n > WATCH_MAX_REPOS_LIMIT) throw new ValidationError(`Enter a whole number of repositories from ${WATCH_MAX_REPOS_MIN} to ${WATCH_MAX_REPOS_LIMIT}.`);
  return n;
}

export async function saveWatchSettings(db: Db, o: { enabled: boolean; seconds: number; maxRepos?: number }): Promise<void> {
  const data = { watchEnabled: o.enabled, watchSeconds: o.seconds, ...(o.maxRepos === undefined ? {} : { watchMaxRepos: o.maxRepos }) };
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", ...data }, update: data });
}
