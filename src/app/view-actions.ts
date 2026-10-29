"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { deleteView, saveView, setViewShared, VIEW_PAGES, isViewScope } from "@/lib/services/views";

function refresh(scope: string) {
  if (isViewScope(scope)) revalidatePath(VIEW_PAGES[scope]);
}

export async function saveViewAction(input: { scope: string; name: string; query: string; shared: boolean }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await saveView(db, viewer, input);
    refresh(input.scope);
    return { ok: true, message: "View saved" };
  });
}

export async function shareViewAction(input: { scope: string; id: string; shared: boolean }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setViewShared(db, viewer, input.id, input.shared);
    refresh(input.scope);
    return { ok: true };
  });
}

export async function deleteViewAction(input: { scope: string; id: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteView(db, viewer, input.id);
    refresh(input.scope);
    return { ok: true };
  });
}
