/** What the top bar says about refreshing tracked source repositories. Pure: the layout feeds it counts read from the local database. */

export type SourceCounts = {
  tracked: number;
  /** sync.repository jobs running now */
  running: number;
  /** sync.repository jobs waiting (including retries scheduled for later) */
  queued: number;
  /** tracked repositories GitHub refused (sign-in, access, SSO, not found): trackingStatus DISCONNECTED */
  refused: number;
  rateLimited: number;
  /** last attempt failed without a refusal (typically the network) */
  failed: number;
  neverSynced: number;
};

export type SourceState = "syncing" | "signin" | "rate-limited" | "offline" | "synced";
export type SourceStatus = { state: SourceState; detail: string };

/**
 * Most urgent first. Refresh in progress is shown ONLY while jobs are really queued or running; a refused repository is
 * "sign-in or access", never "offline", and a network failure is never reported as an authorization problem.
 */
export function deriveSourceStatus(c: SourceCounts): SourceStatus | null {
  if (c.tracked === 0) return null;
  if (c.refused > 0) return { state: "signin", detail: `GitHub refused access to ${n(c.refused)} tracked repositor${c.refused === 1 ? "y" : "ies"}. Check your GitHub sign-in or access, then refresh.` };
  if (c.rateLimited > 0) return { state: "rate-limited", detail: `GitHub's request limit was reached for ${n(c.rateLimited)} repositor${c.rateLimited === 1 ? "y" : "ies"}. Data shown is the last successful refresh.` };
  const active = c.running + c.queued;
  // A failed repository waiting for its retry is not "syncing": nothing is running, GitHub could not be reached.
  if (c.failed > 0 && c.running === 0) return { state: "offline", detail: `The last refresh failed for ${n(c.failed)} repositor${c.failed === 1 ? "y" : "ies"} (GitHub could not be reached or answered with an error). Data shown is the last successful refresh.` };
  if (active > 0) return { state: "syncing", detail: `Refreshing tracked repositories: ${n(c.running)} running, ${n(c.queued)} waiting.${c.neverSynced > 0 ? ` ${n(c.neverSynced)} have not been synchronized yet, so their open items are unknown, not zero.` : ""}` };
  return { state: "synced", detail: c.neverSynced > 0 ? `${n(c.neverSynced)} repositories have not been synchronized yet.` : "All tracked repositories were refreshed." };
}

const n = (x: number) => String(x);
