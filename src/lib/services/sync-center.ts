import type { Db } from "@/lib/db";
import { syncFacts, type SyncFact } from "@/lib/domain/sync-facts";
import { expectedConsistencyDelaySeconds } from "@/lib/sync/engine";

export type SpaceSyncView = { id: string; fullName: string; kind: string; facts: SyncFact[]; lastPolledAt: Date | null; nextPollAt: Date | null; lastPushedAt: Date | null };

/** Per space: what is saved here, what is queued, what has been published and what teammates have not had a chance to see yet. */
export async function syncCenter(db: Db, pollSeconds: number, now = new Date()): Promise<SpaceSyncView[]> {
  const spaces = await db.space.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  const out: SpaceSyncView[] = [];
  for (const s of spaces) {
    const [queued, sending, failed, blocked, conflicts] = await Promise.all([
      db.outboxOp.count({ where: { spaceId: s.id, status: "PENDING", error: null } }),
      db.outboxOp.count({ where: { spaceId: s.id, status: "SENT" } }),
      db.outboxOp.count({ where: { spaceId: s.id, status: { in: ["PENDING", "FAILED"] }, error: { not: null } } }),
      db.outboxOp.count({ where: { spaceId: s.id, status: "QUARANTINED" } }),
      db.syncConflict.count({ where: { spaceId: s.id, status: "OPEN" } }),
    ]);
    out.push({
      id: s.id,
      fullName: `${s.repoOwner}/${s.repoName}`,
      kind: s.kind,
      lastPolledAt: s.lastPolledAt,
      nextPollAt: s.nextPollAt,
      lastPushedAt: s.lastPushedAt,
      facts: syncFacts({ queued, sending, failed, blocked, conflicts, deferred: s.deferredCount, access: s.access, lastPushedAt: s.lastPushedAt, lastPolledAt: s.lastPolledAt, nextPollAt: s.nextPollAt, rateLimitedUntil: s.rateLimitedUntil, lastError: s.lastError, canWrite: s.canWrite, teammateDelaySeconds: expectedConsistencyDelaySeconds(pollSeconds).worst, now }),
    });
  }
  return out;
}
