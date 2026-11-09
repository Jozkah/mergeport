import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { NotFoundError } from "@/lib/errors";
import { changesSince, takeSnapshot, type Change, type Snapshot } from "@/lib/domain/changes";
import { viaRepo } from "@/lib/authz/viewer";

/**
 * "Since you last looked", per person and per item. The first look only records a baseline (nothing is shown as new). After that,
 * changes stay listed until the person acknowledges them: opening the page does not silently dismiss them.
 * Local to this computer; never synchronised.
 */
async function load(db: Db, v: Viewer, workItemId: string) {
  const item = await db.workItem.findFirst({ where: { id: workItemId, ...viaRepo(v) }, include: { comments: true } });
  if (!item) throw new NotFoundError();
  return item;
}

export async function sinceLastLooked(db: Db, v: Viewer, workItemId: string): Promise<{ changes: Change[]; seenAt: Date | null }> {
  const item = await load(db, v, workItemId);
  const cur = takeSnapshot(item, v.login);
  const key = { userId_workItemId: { userId: v.userId, workItemId } };
  const prev = await db.seenState.findUnique({ where: key });
  if (!prev) {
    await db.seenState.create({ data: { userId: v.userId, workItemId, snapshot: cur as never } });
    return { changes: [], seenAt: null };
  }
  return { changes: changesSince(prev.snapshot as unknown as Snapshot, cur), seenAt: prev.seenAt };
}

export async function markSeen(db: Db, v: Viewer, workItemId: string) {
  const item = await load(db, v, workItemId);
  const snapshot = takeSnapshot(item, v.login) as never;
  await db.seenState.upsert({ where: { userId_workItemId: { userId: v.userId, workItemId } }, create: { userId: v.userId, workItemId, snapshot }, update: { snapshot, seenAt: new Date() } });
}
