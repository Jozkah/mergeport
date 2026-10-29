import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

type Tx = Db | Prisma.TransactionClient;
type Actor = { workspaceId: string; userId: string | null };

export async function audit(tx: Tx, actor: Actor, action: string, target?: { type: string; id: string }, meta?: Prisma.InputJsonValue) {
  await tx.auditLog.create({
    data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action, targetType: target?.type, targetId: target?.id, meta },
  });
}
