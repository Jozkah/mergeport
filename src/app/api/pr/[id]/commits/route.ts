import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { pullCommitsView } from "@/lib/services/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer((v) => pullCommitsView(db, v, id));
}
