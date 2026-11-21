import type { Db } from "@/lib/db";

/** Cookie that names the workspace the person last picked (a preference: membership is always re-checked on the server). */
export const WORKSPACE_COOKIE = "mp_ws";

/**
 * The workspace a signed-in user is working in. One active membership: that workspace. Several: the one named by the `mp_ws`
 * cookie if the user is an active member of it, otherwise the oldest membership. No active membership: null.
 * The cookie value is untrusted input: it only ever selects among memberships the user already has.
 */
export async function resolveActiveWorkspaceId(db: Db, user: { id: string }, cookieValue?: string | null): Promise<string | null> {
  const memberships = await db.member.findMany({ where: { userId: user.id, status: "ACTIVE" }, select: { workspaceId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (memberships.length === 0) return null;
  if (memberships.length > 1 && cookieValue && memberships.some((m) => m.workspaceId === cookieValue)) return cookieValue;
  return memberships[0].workspaceId;
}

/**
 * Binds a login session to a workspace the person is an ACTIVE member of. Returns false (and changes nothing) for a workspace
 * the person never joined or was revoked from. resolveActiveWorkspaceId re-checks the membership on every request, so a
 * revocation after this call takes effect on the next one.
 */
export async function selectWorkspace(db: Db, session: { id: string; userId: string }, workspaceId: string): Promise<boolean> {
  const m = await db.member.findFirst({ where: { userId: session.userId, workspaceId, status: "ACTIVE" }, select: { id: true } });
  if (!m) return false;
  await db.session.updateMany({ where: { id: session.id, userId: session.userId }, data: { activeWorkspaceId: workspaceId } });
  return true;
}
