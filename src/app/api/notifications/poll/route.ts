import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { desktopCandidates } from "@/lib/services/notification-prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the open app may show as a desktop pop-up, given the person's own preferences. Never cached. */
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("after"));
  const after = new Date(Number.isFinite(raw) && raw > 0 ? raw : Date.now());
  return withViewer(async (v) => ({ now: Date.now(), items: (await desktopCandidates(db, v, after)).map((n) => ({ id: n.id, title: n.title, href: n.href, at: n.createdAt.getTime() })) }));
}
