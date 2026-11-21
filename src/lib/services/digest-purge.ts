import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/**
 * Deletes the stored daily digests of these people in one workspace. A stored digest is a snapshot of titles taken while the person
 * could see a repository; when that access ends (a grant revoked, a repository untracked, a member removed, a public repository
 * turning private) the snapshot would outlive it, so it goes. The next digest is built from what the person may see then.
 */
export async function purgeDigests(tx: Db | Prisma.TransactionClient, workspaceId: string, userIds: string[]): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  return (await tx.dailyDigest.deleteMany({ where: { workspaceId, userId: { in: ids } } })).count;
}
