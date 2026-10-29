"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { applyQuick, previewQuick, type QuickPreview, type Target } from "@/lib/services/quick-actions";

const target = (type: string, id: string): Target => ({ type: type === "work" ? "work" : "task", id });

/** Shows what the commands would do, in words and with where each one is written. Changes nothing. */
export async function previewQuickAction(type: string, id: string, text: string): Promise<{ ok: true; preview: QuickPreview } | { ok: false; error: string }> {
  const r = await run(async () => {
    const { viewer } = await requireViewer();
    return { ok: true, data: { preview: await previewQuick(db, viewer, target(type, id), text) } };
  });
  return r.ok ? { ok: true, preview: r.data!.preview as QuickPreview } : { ok: false, error: r.error };
}

export async function applyQuickAction(type: string, id: string, text: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const r = await applyQuick({ db, v: viewer }, target(type, id), text);
    revalidatePath("/", "layout");
    return { ok: true, message: r.writesTo === "github" ? `Applied to GitHub (${r.applied} change${r.applied === 1 ? "" : "s"})` : `Applied (${r.applied} change${r.applied === 1 ? "" : "s"})` };
  });
}
