import type { Db } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";
import { take } from "@/lib/auth/rate-limit";
import { ensureCommonSpace } from "@/lib/services/access-spaces";

export const WORKSPACE_NAME_MAX = 80;
export const WORKSPACES_PER_DAY = 5;

/** Creates a workspace for a person and makes them its OWNER (the one owner, see docs/roles.md) with the COMMON space, then binds their session to it. */
export async function createWorkspaceFor(db: Db, userId: string, rawName: unknown, sessionId?: string): Promise<{ id: string; name: string }> {
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ValidationError("Give the workspace a name.");
  if (name.length > WORKSPACE_NAME_MAX) throw new ValidationError(`Keep the name under ${WORKSPACE_NAME_MAX + 1} characters.`);
  // Each workspace is a fresh invitation budget, so how many one person may make is capped (MERGEPORT_MAX_WORKSPACES_PER_DAY, default 5).
  const raw = process.env.MERGEPORT_MAX_WORKSPACES_PER_DAY?.trim() ?? "";
  const max = /^[0-9]{1,3}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : WORKSPACES_PER_DAY;
  if (!(await take(db, `ws:create:${userId}`, max, 24 * 3600 * 1000))) throw new ConflictError("You have created several workspaces today. Try again tomorrow.");
  return db.$transaction(async (tx) => {
    const ws = await tx.workspace.create({ data: { name }, select: { id: true, name: true } });
    await tx.member.create({ data: { workspaceId: ws.id, userId, role: "OWNER", status: "ACTIVE" } });
    await ensureCommonSpace(tx, ws.id);
    await tx.teamConfig.create({ data: { workspaceId: ws.id, mode: "PERSONAL" } });
    if (sessionId) await tx.session.updateMany({ where: { id: sessionId, userId }, data: { activeWorkspaceId: ws.id } });
    return ws;
  });
}

/** The workspaces a person can switch between: ACTIVE memberships only. */
export async function activeWorkspaces(db: Db, userId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db.member.findMany({ where: { userId, status: "ACTIVE" }, select: { workspace: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => r.workspace);
}
