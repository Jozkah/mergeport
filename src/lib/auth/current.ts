import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { WORKSPACE_COOKIE, resolveActiveWorkspaceId } from "@/lib/authz/active-workspace";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { SESSION_COOKIE, findSession } from "./session";

/** Per-request identity. Memoized for one render only; never across requests. */
export const getAuth = cache(async () => {
  const jar = await cookies();
  const s = await findSession(db, jar.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  // The active workspace: the person's only membership, else the mp_ws cookie if it names one of theirs, else the oldest.
  const workspaceId = await resolveActiveWorkspaceId(db, { id: s.userId }, jar.get(WORKSPACE_COOKIE)?.value);
  const viewer = workspaceId ? await loadViewer(db, s.userId, workspaceId) : null;
  return { user: s.user, session: s, viewer };
});

export async function requireViewer(): Promise<{ user: NonNullable<Awaited<ReturnType<typeof getAuth>>>["user"]; viewer: Viewer; csrf: string }> {
  const a = await getAuth();
  if (!a || !a.viewer) redirect("/sign-in");
  return { user: a.user, viewer: a.viewer, csrf: a.session.csrfToken };
}

/** Administrator = GitHub says this account administers the team's common space (or it is a personal profile). */
export async function requireAdminViewer() {
  const a = await requireViewer();
  if (!a.viewer.isAdmin) notFound(); // non-admins get the same 404 as a missing page
  return a;
}
