import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/services/audit";
import { disconnectRemovedRepositories, markInstallationState } from "./binding";

/**
 * What GitHub tells us about an installation's own life (the `installation` and `installation_repositories` events). Everything here
 * runs inside the delivery's transaction. The installation id has already been matched to a known `GithubInstallation` row; the payload
 * only decides WHICH state to record, never who is bound or what is trusted. Bindings and their proof columns are never touched.
 */

type Tx = Prisma.TransactionClient;
type InstallationRow = { installationId: bigint; suspendedAt: Date | null; deletedAt: Date | null };

const STATE_FOR_ACTION: Record<string, "active" | "suspended" | "deleted"> = {
  deleted: "deleted",
  suspend: "suspended",
  unsuspend: "active",
  created: "active",
  new_permissions_accepted: "active",
};

export const INSTALLATION_ACTIONS = new Set(Object.keys(STATE_FOR_ACTION));

const stateOf = (r: InstallationRow) => (r.deletedAt ? "deleted" : r.suspendedAt ? "suspended" : "active");

/**
 * Records the new state on the global row (every workspace sees it at once) and writes one audit row per bound workspace, but only when
 * the state really changed (a repeated `suspend` or a `created` for an installation that is already active writes nothing).
 */
export async function applyInstallationEvent(tx: Tx, installation: InstallationRow, action: string, now = new Date()): Promise<{ changed: boolean }> {
  const next = STATE_FOR_ACTION[action];
  if (!next || stateOf(installation) === next) return { changed: false };
  await markInstallationState(tx, installation.installationId, next, now);
  const bindings = await tx.workspaceInstallation.findMany({ where: { installationId: installation.installationId }, select: { workspaceId: true }, orderBy: { workspaceId: "asc" } });
  for (const b of bindings) await audit(tx, { workspaceId: b.workspaceId, userId: null }, `github.installation-${next}`, { type: "GithubInstallation", id: String(installation.installationId) }, { source: "webhook" });
  return { changed: true };
}

const MAX_IDS = 1000;

/** The GitHub ids named by a payload's repository list (`repositories_removed`): safe positive integers only, bounded, no duplicates. */
export function repositoryIds(list: unknown): bigint[] {
  if (!Array.isArray(list)) return [];
  const ids = new Set<bigint>();
  for (const r of list.slice(0, MAX_IDS)) {
    const id = (r as { id?: unknown } | null)?.id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.add(BigInt(id));
  }
  return [...ids];
}

/** `installation_repositories` removed: tracked repositories that lost their access become DISCONNECTED and detached, with an audit row per workspace. */
export async function applyRepositoriesRemoved(tx: Tx, installationId: bigint, removed: unknown): Promise<{ workspaces: number; repositories: number }> {
  const affected = await disconnectRemovedRepositories(tx, installationId, repositoryIds(removed));
  for (const a of affected) await audit(tx, { workspaceId: a.workspaceId, userId: null }, "github.repositories-removed", { type: "GithubInstallation", id: String(installationId) }, { repositoriesDisconnected: a.count, source: "webhook" });
  return { workspaces: affected.length, repositories: affected.reduce((n, a) => n + a.count, 0) };
}
