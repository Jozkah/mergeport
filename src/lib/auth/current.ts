import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { maybeRequestAccessRefresh } from "@/lib/github/access-cache";
import { isHosted } from "@/lib/public-url";
import { WORKSPACE_COOKIE, resolveActiveWorkspaceId } from "@/lib/authz/active-workspace";
import { loadViewer, requireWrite, type Viewer } from "@/lib/authz/viewer";
import { SESSION_COOKIE, findSession } from "./session";

/** Per-request identity. Memoized for one render only; never across requests. */
export const getAuth = cache(async () => {
  const jar = await cookies();
  const s = await findSession(db, jar.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  // The active workspace: the person's only membership, else the one this session was bound to (switcher), else the mp_ws cookie
  // (older sessions), else the oldest. Each candidate is only a choice among memberships the person still has.
  const workspaceId = await resolveActiveWorkspaceId(db, { id: s.userId }, s.activeWorkspaceId ?? jar.get(WORKSPACE_COOKIE)?.value);
  const viewer = workspaceId ? await loadViewer(db, s.userId, workspaceId) : null;
  // A linked person whose GitHub access data is getting old: ask for a refresh. Queued and never awaited, so no page waits for GitHub.
  if (viewer && viewer.githubId !== null && isHosted()) void maybeRequestAccessRefresh(db, s.userId).catch(() => {});
  return { user: s.user, session: s, viewer };
});

export async function requireViewer(): Promise<{ user: NonNullable<Awaited<ReturnType<typeof getAuth>>>["user"]; viewer: Viewer; csrf: string }> {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  // Signed in but in no workspace (a first email or OIDC login): create one.
  if (!a.viewer) redirect("/onboarding");
  return { user: a.user, viewer: a.viewer, csrf: a.session.csrfToken };
}

/**
 * The guard for every mutating server action: a signed-in viewer whose role may write (not READER). Throws ForbiddenError, which
 * `run()` turns into a message. Actions that only touch the caller's own preferences use requireViewer and are listed, with a reason,
 * in tests/mutation-guard.test.ts.
 */
export async function requireWriter() {
  const a = await requireViewer();
  requireWrite(a.viewer);
  return a;
}

/** Administrator = OWNER or ADMIN of the active workspace. Non-administrators get the same 404 as a missing page. */
export async function requireAdminViewer() {
  const a = await requireViewer();
  if (!a.viewer.isAdmin) notFound(); // non-admins get the same 404 as a missing page
  return a;
}
