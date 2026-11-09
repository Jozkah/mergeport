/**
 * Pure numbers and words of the repository auto-sync watcher (repo-watch.ts). No database, so pages and client components can import it.
 */
export const WATCH_MIN_SECONDS = 2;
export const WATCH_MAX_SECONDS = 300;
export const WATCH_DEFAULT_SECONDS = 15;
/** Most repositories watched at once (the least recently synced first); the default and the bounds of the setting. */
export const WATCH_MAX_REPOS = 20;
export const WATCH_MAX_REPOS_MIN = 1;
export const WATCH_MAX_REPOS_LIMIT = 200;
/** Two conditional requests per repository and probe: the issues list and the latest commit. */
export const PROBES_PER_REPO = 2;
/** Total probe requests per minute across all watched repositories. GitHub's secondary limit is about 900 per minute per account. */
export const WATCH_MAX_REQUESTS_PER_MINUTE = 300;

/** Seconds between two probes of one repository: the configured value, stretched when the request budget would be exceeded. */
export function effectiveWatchSeconds(configured: number, repos: number): number {
  const budget = Math.ceil((repos * PROBES_PER_REPO * 60) / WATCH_MAX_REQUESTS_PER_MINUTE); // 0.2 s per request
  return Math.max(configured, budget);
}

export type WatchSummary = { enabled: boolean; maxRepos: number; configured: number; effective: number; repos: number; stretched: boolean };

export const watchSummary = (enabled: boolean, configured: number, repos: number, maxRepos = WATCH_MAX_REPOS): WatchSummary => {
  const effective = effectiveWatchSeconds(configured, repos);
  return { enabled, maxRepos, configured, effective, repos, stretched: effective > configured };
};

/** "~15 s", "~1 min". */
export const watchLabel = (s: number) => (s < 60 ? `~${s} s` : `~${Math.round(s / 60)} min`);
export const watchTitle = (s: number) =>
  s < 60 ? `Checked about every ${s} second${s === 1 ? "" : "s"} while Mergeport is open` : `Checked about every ${s < 90 ? "minute" : `${Math.round(s / 60)} minutes`} while Mergeport is open`;
