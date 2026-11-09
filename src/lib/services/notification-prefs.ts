import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { listNotifications } from "./queries";
import { DEFAULT_PREFS, parsePrefs, wantsDesktop, type Prefs } from "@/lib/domain/notify-prefs";

/** Personal and local: preferences are never synchronised and never leave this computer. */
export async function getPrefs(db: Db, userId: string): Promise<Prefs> {
  const row = await db.notificationPref.findUnique({ where: { userId } });
  return row ? parsePrefs(row.prefs) : DEFAULT_PREFS;
}

export async function setPrefs(db: Db, userId: string, input: unknown): Promise<Prefs> {
  const prefs = parsePrefs(input);
  await db.notificationPref.upsert({ where: { userId }, create: { userId, prefs: prefs as never }, update: { prefs: prefs as never } });
  return prefs;
}

/**
 * Unread notifications that should pop up on the desktop right now: opted in for their kind, outside quiet hours, newer than `after`,
 * and (as everywhere) only for repositories the person can still see. Called by the open app; with Mergeport closed nothing is
 * delivered, because there is no server to do it.
 */
export async function desktopCandidates(db: Db, v: Viewer, after: Date, now = new Date()) {
  const prefs = await getPrefs(db, v.userId);
  const rows = await listNotifications(db, v, 30);
  return rows.filter((n) => !n.readAt && n.createdAt > after && wantsDesktop(prefs, n.kind, now, v.timezone)).reverse();
}
