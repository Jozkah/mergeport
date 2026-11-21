import type { Db } from "@/lib/db";
import { githubAppConfigured } from "./app-config";

/**
 * Is this workspace connected to GitHub? One answer for every page, banner and gate (hosted deployments; the local app uses `gh`).
 *
 * - `configured`: the operator set up the GitHub App for this deployment (see docs/github-app.md).
 * - `bound`: the workspace has at least one proved binding to an installation that is neither suspended nor uninstalled, so
 *   repository sync and discovery work.
 * - `suspended`: the workspace has a binding whose installation the account owner suspended (and none usable). Sync waits until
 *   it is resumed; nothing is lost.
 */
export type WorkspaceGithubStatus = { configured: boolean; bound: boolean; suspended: boolean };

export async function workspaceGithubStatus(db: Db, workspaceId: string): Promise<WorkspaceGithubStatus> {
  const rows = await db.workspaceInstallation.findMany({ where: { workspaceId }, select: { verifiedAt: true, installation: { select: { suspendedAt: true, deletedAt: true } } } });
  const live = rows.filter((r) => r.verifiedAt && !r.installation.deletedAt);
  const bound = live.some((r) => !r.installation.suspendedAt);
  return { configured: githubAppConfigured(), bound, suspended: !bound && live.some((r) => r.installation.suspendedAt) };
}
