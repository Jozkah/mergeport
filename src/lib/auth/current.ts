import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { SESSION_COOKIE, findSession } from "./session";

/** Per-request identity. Memoized for one render only; never across requests. */
export const getAuth = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await findSession(db, token);
  if (!s) return null;
  const viewer = await loadViewer(db, s.userId);
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
