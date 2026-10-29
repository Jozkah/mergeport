import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { listDrafts } from "@/lib/services/review-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only the caller's own pending comments: a draft review is personal until it is submitted. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer(async (v) => ({ drafts: await listDrafts(db, v, id) }));
}
