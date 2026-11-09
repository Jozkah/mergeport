"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { setPrefs } from "@/lib/services/notification-prefs";

/** Personal preferences for this computer. Nothing is shared with the team. */
export async function savePrefsAction(prefs: unknown): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setPrefs(db, viewer.userId, prefs);
    revalidatePath("/settings");
    return { ok: true, message: "Saved" };
  });
}
