import type { Db } from "@/lib/db";

/**
 * One in-app notification of the upstream auto-updater, to the administrators who can see the fork, unless they turned the kind off.
 * Shared by the merge pipeline and the release watch so both honour the same preference.
 */
export async function notifyUpstream(db: Db, r: { kind: "upstream-update" | "upstream-release"; mappingId: string; forkRepoId: string; workspaceId: string; title: string }) {
  const admins = await db.member.findMany({ where: { workspaceId: r.workspaceId, status: "ACTIVE", role: "ADMIN" }, select: { userId: true } });
  for (const a of admins) {
    const pref = await db.notificationPref.findUnique({ where: { userId: a.userId } });
    // The kind is not in the Settings list yet (that list is fixed by tests/notify.test.ts); a stored `inApp: false` for it is honoured.
    // Both kinds are one setting, "upstream-update".
    const own = (pref?.prefs as { kinds?: Record<string, { inApp?: unknown }> } | null | undefined)?.kinds?.["upstream-update"];
    if (own?.inApp === false) continue;
    await db.notification.create({ data: { workspaceId: r.workspaceId, userId: a.userId, repositoryId: r.forkRepoId, kind: r.kind, title: r.title.slice(0, 200), href: `/forks#m-${r.mappingId}` } });
  }
}
