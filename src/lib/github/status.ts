import type { Db } from "@/lib/db";
import { githubAppConfigured } from "./app-config";

/** One word for the banner and the Get started card: `ok` (a usable connection), `suspended`, `removed` (all uninstalled) or `none`. */
export type ConnectionState = "none" | "ok" | "suspended" | "removed";

/**
 * Is this workspace connected to GitHub? THE one answer for every page, banner and gate (hosted deployments; the local app uses `gh`).
 * `connectionState` (connection-state.ts) is derived from it.
 *
 * - `configured`: the operator set up the GitHub App for this deployment (see docs/github-app.md).
 * - `bound`: at least one proved binding to an installation that is neither suspended nor uninstalled (state `ok`): sync and discovery work.
 * - `suspended`: bindings exist and none is usable, and at least one is suspended (not removed). Sync waits until it is resumed.
 * - `state`: the same facts as one word.
 */
export type WorkspaceGithubStatus = { configured: boolean; bound: boolean; suspended: boolean; state: ConnectionState };

export async function workspaceGithubStatus(db: Db, workspaceId: string): Promise<WorkspaceGithubStatus> {
  const rows = await db.workspaceInstallation.findMany({ where: { workspaceId }, select: { verifiedAt: true, installation: { select: { suspendedAt: true, deletedAt: true } } }, take: 50 });
  const live = rows.filter((r) => r.verifiedAt && !r.installation.deletedAt);
  const bound = live.some((r) => !r.installation.suspendedAt);
  const suspended = !bound && live.length > 0;
  const state: ConnectionState = rows.length === 0 ? "none" : bound ? "ok" : suspended ? "suspended" : "removed";
  return { configured: githubAppConfigured(), bound, suspended, state };
}
