import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { pullBlobView } from "@/lib/services/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = new URL(req.url).searchParams.get("path") ?? "";
  return withViewer((v) => pullBlobView(db, v, id, path));
}
