import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { reviewThreads } from "@/lib/services/review-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer((v) => reviewThreads(db, v, id));
}
