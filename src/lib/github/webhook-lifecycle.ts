import type { Db } from "@/lib/db";

/**
 * What GitHub tells us about an installation's own life (the `installation` and `installation_repositories` events). Deliveries arrive
 * late and out of order, so NOTHING here flips a state from the event's action word: the route queues `github.installation.check`
 * (installation-check.ts, which asks GitHub what is true now) and, for removed repositories, a refresh of each tracked repository, whose
 * own 404 handling disconnects it only when GitHub really no longer shows it to the installation. Bindings and proof columns are never touched.
 */

/** The most repository ids read from one delivery; the rest are left to the next reconcile (a hint is queued). */
export const MAX_REMOVED_IDS = 2000;
const CHUNK = 500;

/** The GitHub ids named by a payload's repository list: safe positive integers only, no duplicates, at most `MAX_REMOVED_IDS`. */
export function repositoryIds(list: unknown): { ids: bigint[]; truncated: boolean } {
  if (!Array.isArray(list)) return { ids: [], truncated: false };
  const ids = new Set<bigint>();
  let truncated = false;
  for (const r of list) {
    const id = (r as { id?: unknown } | null)?.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (ids.size >= MAX_REMOVED_IDS && !ids.has(BigInt(id))) {
      truncated = true;
      break;
    }
    ids.add(BigInt(id));
  }
  return { ids: [...ids], truncated };
}

/**
 * Tracked repository rows (ACTIVE or DISCONNECTED) that name this installation, among the GitHub ids, in every workspace bound to it.
 * The ids only FIND rows that already belong to the installation; read in chunks so a large removal is neither sliced nor one huge query.
 */
export async function trackedRepositoriesAmong(db: Db, installationId: bigint, githubIds: bigint[]): Promise<{ workspaceId: string; repositoryId: string }[]> {
  const bindings = await db.workspaceInstallation.findMany({ where: { installationId }, select: { workspaceId: true }, orderBy: { workspaceId: "asc" } });
  const out: { workspaceId: string; repositoryId: string }[] = [];
  for (const b of bindings) {
    for (let i = 0; i < githubIds.length; i += CHUNK) {
      const rows = await db.repository.findMany({
        where: { workspaceId: b.workspaceId, installationId, githubId: { in: githubIds.slice(i, i + CHUNK) }, trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const r of rows) out.push({ workspaceId: b.workspaceId, repositoryId: r.id });
    }
  }
  return out;
}
