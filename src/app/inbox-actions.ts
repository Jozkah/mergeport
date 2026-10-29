"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { markAllRead, markDone, markRead, reopen, snooze } from "@/lib/services/inbox";
import { markSeen } from "@/lib/services/seen";

type Op = "read" | "done" | "reopen" | "snooze-4h" | "snooze-tomorrow" | "snooze-week";

/** Personal state only: nothing here is sent to GitHub or to teammates. */
export async function inboxAction(itemId: string, op: Op): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const now = new Date();
    if (op === "read") await markRead(db, viewer, itemId);
    else if (op === "done") await markDone(db, viewer, itemId);
    else if (op === "reopen") await reopen(db, viewer, itemId);
    else if (op === "snooze-4h") await snooze(db, viewer, itemId, new Date(now.getTime() + 4 * 3_600_000));
    else if (op === "snooze-tomorrow") {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      await snooze(db, viewer, itemId, t);
    } else await snooze(db, viewer, itemId, new Date(now.getTime() + 7 * 86_400_000));
    revalidatePath("/inbox");
    return { ok: true };
  });
}

export async function inboxReadAllAction(): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await markAllRead(db, viewer);
    revalidatePath("/inbox");
    return { ok: true };
  });
}

/** Acknowledge what changed on an item: personal, local, and never a review decision. */
export async function markSeenAction(itemId: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await markSeen(db, viewer, itemId);
    revalidatePath(`/pull-requests/${itemId}`);
    revalidatePath(`/issues/${itemId}`);
    return { ok: true };
  });
}
