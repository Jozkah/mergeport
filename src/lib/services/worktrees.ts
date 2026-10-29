import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireRepo, type Viewer } from "@/lib/authz/viewer";
import { collectSnapshot, validateRoot, GitError, type Snapshot } from "@/lib/local/git";
import { audit } from "./audit";

/**
 * Local worktree visibility. The app runs on the machine that holds the folders, so it reads them directly, read-only:
 *  - argument-array git subprocesses with a fixed allow-list of read-only subcommands (src/lib/local/git.ts);
 *  - only folders the person explicitly maps, and only for repositories they can already see;
 *  - counts and ref names only: never file names, diffs, file contents or environment files;
 *  - snapshots live in the local database and are NEVER written to any coordination repository.
 */

const STALE_AFTER_MS = 10 * 60_000;

async function localDevice(db: Db, v: Viewer) {
  return (await db.device.findFirst({ where: { userId: v.userId } })) ?? db.device.create({ data: { userId: v.userId, name: "This computer" } });
}

/** Maps a repository to a folder on this machine. The folder must be the top level of a git repository. */
export async function mapLocalRoot(db: Db, v: Viewer, repositoryId: string, absolutePath: string) {
  await requireRepo(db, v, repositoryId, "view");
  let root: string;
  try {
    root = await validateRoot(absolutePath);
  } catch (e) {
    throw new ValidationError(e instanceof GitError ? e.message : "That folder cannot be used");
  }
  const dev = await localDevice(db, v);
  await db.deviceRepoMapping.upsert({ where: { deviceId_repositoryId: { deviceId: dev.id, repositoryId } }, create: { deviceId: dev.id, repositoryId, rootPath: root }, update: { rootPath: root } });
  await audit(db, v, "worktree.map", { type: "Repository", id: repositoryId });
  return root;
}

export async function unmapLocalRoot(db: Db, v: Viewer, repositoryId: string) {
  const dev = await localDevice(db, v);
  await db.deviceRepoMapping.deleteMany({ where: { deviceId: dev.id, repositoryId } });
  await db.worktreeSnapshot.deleteMany({ where: { deviceId: dev.id, repositoryId } });
}

export async function scanWorktrees(db: Db, v: Viewer, repositoryId: string, now = new Date()) {
  await requireRepo(db, v, repositoryId, "view"); // a revoked repository can no longer be scanned
  const dev = await localDevice(db, v);
  const map = await db.deviceRepoMapping.findFirst({ where: { deviceId: dev.id, repositoryId } });
  if (!map?.rootPath) throw new NotFoundError();
  const snap = await collectSnapshot(await validateRoot(map.rootPath), now);
  await db.worktreeSnapshot.upsert({
    where: { deviceId_repositoryId: { deviceId: dev.id, repositoryId } },
    create: { deviceId: dev.id, repositoryId, capturedAt: now, data: snap as unknown as Prisma.InputJsonValue },
    update: { capturedAt: now, data: snap as unknown as Prisma.InputJsonValue },
  });
  await db.device.update({ where: { id: dev.id }, data: { lastSeenAt: now } });
  return snap;
}

export type WorktreeView = { machine: string; capturedAt: Date; stale: boolean; rootPath: string | null; worktrees: Snapshot["worktrees"] };

export async function worktreesFor(db: Db, v: Viewer, repositoryId: string, now = new Date()): Promise<WorktreeView | null> {
  await requireRepo(db, v, repositoryId, "view");
  const dev = await db.device.findFirst({ where: { userId: v.userId } });
  if (!dev) return null;
  const [snap, map] = await Promise.all([db.worktreeSnapshot.findFirst({ where: { deviceId: dev.id, repositoryId } }), db.deviceRepoMapping.findFirst({ where: { deviceId: dev.id, repositoryId } })]);
  if (!snap) return map ? { machine: dev.name, capturedAt: new Date(0), stale: true, rootPath: map.rootPath, worktrees: [] } : null;
  const data = snap.data as unknown as Snapshot;
  return { machine: dev.name, capturedAt: snap.capturedAt, stale: now.getTime() - snap.capturedAt.getTime() > STALE_AFTER_MS, rootPath: map?.rootPath ?? null, worktrees: data.worktrees };
}
