import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { capabilitiesFor } from "@/lib/authz/viewer";
import { pullFilesView } from "@/lib/services/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer(async (v) => {
    const item = await db.workItem.findFirst({ where: { id }, select: { repositoryId: true } });
    const caps = item ? await capabilitiesFor(db, v, item.repositoryId) : null;
    return pullFilesView(db, v, id, !!caps && (caps.review || caps.manageWork));
  });
}
