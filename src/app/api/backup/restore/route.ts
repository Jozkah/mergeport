import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { withViewerPost } from "@/lib/api-post";
import { parseBackup, restoreBackup } from "@/lib/services/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withViewerPost(req, async (v, body) => {
    const r = await restoreBackup(db, v, parseBackup(body), { confirmed: true });
    revalidatePath("/", "layout");
    return r;
  });
}
