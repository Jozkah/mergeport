import type { Db } from "@/lib/db";
import { loadViewer } from "@/lib/authz/viewer";
import { isQuiet, wantsDesktop } from "@/lib/domain/notify-prefs";
import { getPrefs } from "./notification-prefs";
import { listNotifications } from "./queries";

/**
 * Windows notifications while no browser tab is open. Each new notification is decided exactly once, then stamped (`toastedAt`):
 *   - not wanted as a desktop pop-up (the person's own setting), or older than a day: stamped without a toast;
 *   - a tab is open and visible: the page shows its own pop-up, so it is stamped without a toast;
 *   - quiet hours: left alone, so it is shown when they end;
 *   - otherwise: shown now (up to three separately, more as one summary) and stamped.
 */
export type ToastOut = { title: string; body: string; url: string };
const MAX_AGE_MS = 24 * 3_600_000;
const SEPARATE = 3;

export async function dispatchToasts(db: Db, workspaceId: string, o: { active: boolean; show: (t: ToastOut) => void; baseUrl: string; now?: Date }): Promise<{ shown: number; stamped: number }> {
  const now = o.now ?? new Date();
  const member = await db.member.findFirst({ where: { workspaceId, status: "ACTIVE", user: { isDemo: false } }, orderBy: { createdAt: "asc" } });
  const viewer = member ? await loadViewer(db, member.userId, workspaceId) : null;
  if (!viewer) return { shown: 0, stamped: 0 };
  const pending = (await listNotifications(db, viewer, 50)).filter((n) => !n.readAt && !n.toastedAt).reverse(); // oldest first
  if (pending.length === 0) return { shown: 0, stamped: 0 };
  const prefs = await getPrefs(db, viewer.userId);
  const quiet = isQuiet(prefs, now, viewer.timezone);
  const skip: string[] = [];
  const show: typeof pending = [];
  for (const n of pending) {
    const wanted = wantsDesktop({ ...prefs, quiet: { ...prefs.quiet, enabled: false } }, n.kind, now, viewer.timezone); // quiet hours are handled below
    if (!wanted || now.getTime() - n.createdAt.getTime() > MAX_AGE_MS || o.active) skip.push(n.id);
    else if (!quiet) show.push(n);
  }
  const stamp = async (ids: string[]) => ids.length && (await db.notification.updateMany({ where: { workspaceId, id: { in: ids }, toastedAt: null }, data: { toastedAt: now } }));
  await stamp(skip);
  if (show.length <= SEPARATE) for (const n of show) o.show({ title: n.title, body: "Open it in Mergeport", url: o.baseUrl + (n.href && n.href.startsWith("/") ? n.href : "/inbox") });
  else o.show({ title: `${show.length} new notifications`, body: "Open Mergeport to see them", url: `${o.baseUrl}/activity` });
  await stamp(show.map((n) => n.id));
  return { shown: show.length, stamped: skip.length + show.length };
}
