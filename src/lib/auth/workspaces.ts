import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

export const WORKSPACE_NAME_MAX = 80;

/**
 * Creates a workspace for a person and makes them its administrator, then binds their session to it. The owner role arrives in a
 * later phase; until then the creator is an ADMIN member like the local profile's one person.
 */
export async function createWorkspaceFor(db: Db, userId: string, rawName: unknown, sessionId?: string): Promise<{ id: string; name: string }> {
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ValidationError("Give the workspace a name.");
  if (name.length > WORKSPACE_NAME_MAX) throw new ValidationError(`Keep the name under ${WORKSPACE_NAME_MAX + 1} characters.`);
  return db.$transaction(async (tx) => {
    const ws = await tx.workspace.create({ data: { name }, select: { id: true, name: true } });
    await tx.member.create({ data: { workspaceId: ws.id, userId, role: "ADMIN", status: "ACTIVE" } });
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
