import { db } from "@/lib/db";
import { withViewerPost } from "@/lib/api-post";
import { parseBackup, previewRestore } from "@/lib/services/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withViewerPost(req, (v, body) => previewRestore(db, v, parseBackup(body)));
}
