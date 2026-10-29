"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { setCheckItemDone } from "@/lib/services/checklist";
import { addComment } from "@/lib/services/tasks";

/** Quick actions from the side drawer. Same services, same authorization as the full task page. */
export async function drawerCommentAction(taskId: string, body: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await addComment(db, viewer, taskId, body);
    revalidatePath(`/tasks/${taskId}`);
    return { ok: true };
  });
}

export async function drawerTickAction(taskId: string, checkId: string, done: boolean): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setCheckItemDone(db, viewer, checkId, done);
    revalidatePath(`/tasks/${taskId}`);
    revalidatePath("/planning");
    return { ok: true };
  });
}
