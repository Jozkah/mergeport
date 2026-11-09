import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { compareFilesView } from "@/lib/services/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  return withViewer(async (v) => {
    const r = await compareFilesView(db, v, id, q.get("from") ?? "", q.get("to") ?? "");
    return { headSha: r.to, files: r.files, truncated: r.truncated, inline: {}, canComment: false, from: r.from, to: r.to };
  });
}
