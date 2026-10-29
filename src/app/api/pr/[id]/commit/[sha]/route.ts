import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { commitFilesView } from "@/lib/services/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sha: string }> }) {
  const { id, sha } = await params;
  return withViewer((v) => commitFilesView(db, v, id, sha));
}
