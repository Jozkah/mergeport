import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { WATCH_DEFAULT_SECONDS, WATCH_MAX_REPOS, WATCH_MAX_REPOS_LIMIT, WATCH_MAX_REPOS_MIN, WATCH_MAX_SECONDS, WATCH_MIN_SECONDS } from "@/lib/local/watch-format";

/**
 * Settings of the repository auto-sync watcher, per profile (TeamConfig). Precedence for the interval and the repository
 * count: the value saved on the Settings page, else the environment (MERGEPORT_WATCH_SECONDS, MERGEPORT_WATCH_MAX_REPOS;
 * valid values only), else the built-in default. A NULL column means "never saved here" (or cleared by a blank field).
 * The switch is on by default.
 */
export type WatchConfig = {
  enabled: boolean;
  seconds: number;
  maxRepos: number;
  /** What is saved in the database (null = not set). */
  stored: { seconds: number | null; maxRepos: number | null };
  /** The value used when nothing is saved, and where it comes from. */
  fallback: { seconds: number; maxRepos: number; secondsFromEnv: boolean; maxReposFromEnv: boolean };
};

const validEnv = (name: string, min: number, max: number): boolean => {
  const v = process.env[name];
  const n = v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max;
};

export async function readWatchConfig(db: Db): Promise<WatchConfig> {
  const row = await db.teamConfig.findUnique({ where: { id: "team" }, select: { watchSeconds: true, watchEnabled: true, watchMaxRepos: true } });
  const e = env();
  const fbSeconds = e.MERGEPORT_WATCH_SECONDS ?? WATCH_DEFAULT_SECONDS;
  const fbMax = e.MERGEPORT_WATCH_MAX_REPOS ?? WATCH_MAX_REPOS;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return {
    enabled: row?.watchEnabled ?? true,
    seconds: clamp(row?.watchSeconds ?? fbSeconds, WATCH_MIN_SECONDS, WATCH_MAX_SECONDS),
    maxRepos: clamp(row?.watchMaxRepos ?? fbMax, WATCH_MAX_REPOS_MIN, WATCH_MAX_REPOS_LIMIT),
    stored: { seconds: row?.watchSeconds ?? null, maxRepos: row?.watchMaxRepos ?? null },
    fallback: {
      seconds: fbSeconds,
      maxRepos: fbMax,
      secondsFromEnv: validEnv("MERGEPORT_WATCH_SECONDS", WATCH_MIN_SECONDS, WATCH_MAX_SECONDS),
      maxReposFromEnv: validEnv("MERGEPORT_WATCH_MAX_REPOS", WATCH_MAX_REPOS_MIN, WATCH_MAX_REPOS_LIMIT),
    },
  };
}

export async function readWatchSettings(db: Db): Promise<{ enabled: boolean; seconds: number; maxRepos: number }> {
  const { enabled, seconds, maxRepos } = await readWatchConfig(db);
  return { enabled, seconds, maxRepos };
}

/** A whole number from 2 to 300, or a plain sentence saying what is wrong. A blank field is not accepted here (see `parseOptional`). */
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

/** Blank means "use the default (environment or built-in)": null. */
export const parseOptional = (raw: unknown, parse: (r: unknown) => number): number | null => (String(raw ?? "").trim() === "" ? null : parse(raw));

/**
 * Writes only what is given: `undefined` leaves a column alone, `null` clears it (back to the environment or built-in default).
 * Returns the names of the columns that were written.
 */
export async function saveWatchSettings(db: Db, o: { enabled?: boolean; seconds?: number | null; maxRepos?: number | null }): Promise<string[]> {
  const data: { watchEnabled?: boolean; watchSeconds?: number | null; watchMaxRepos?: number | null } = {};
  if (o.enabled !== undefined) data.watchEnabled = o.enabled;
  if (o.seconds !== undefined) data.watchSeconds = o.seconds;
  if (o.maxRepos !== undefined) data.watchMaxRepos = o.maxRepos;
  const written = Object.keys(data);
  if (written.length === 0) return written;
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", ...data }, update: data });
  return written;
}
