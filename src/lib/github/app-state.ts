import type { Db } from "@/lib/db";

/**
 * Install / OAuth state is single use. A state value is `<workspaceId>.<random>`; the callback reads the workspace id from the front
 * (untrusted), hashes the WHOLE value and claims the row here. The claim is one conditional UPDATE, so two concurrent callbacks with the
 * same state cannot both win, and an expired or already used state claims nothing.
 */
export type ClaimedAppState = { id: string; workspaceId: string; userId: string; kind: string; nonceHash: string | null };

export async function claimAppState(db: Db, input: { workspaceId: string; stateHash: string; now?: Date }): Promise<ClaimedAppState | null> {
  const now = input.now ?? new Date();
  const r = await db.githubAppState.updateMany({
    where: { workspaceId: input.workspaceId, stateHash: input.stateHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (r.count !== 1) return null;
  const row = await db.githubAppState.findFirst({ where: { workspaceId: input.workspaceId, stateHash: input.stateHash } });
  return row ? { id: row.id, workspaceId: row.workspaceId, userId: row.userId, kind: row.kind, nonceHash: row.nonceHash } : null;
}
