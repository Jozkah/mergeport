"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { setAvailability } from "@/lib/services/capacity";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const day = (s: string, end = false) => (s ? new Date(`${s}T${end ? "23:59:59" : "00:00:00"}Z`) : null);

/** Shared team configuration: who is away and who covers. It suggests a backup; it never reassigns or notifies anyone. */
export async function availabilityAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setAvailability(db, viewer, {
      login: str(fd, "login"),
      clear: str(fd, "clear") === "1",
      unavailableFrom: day(str(fd, "from")),
      unavailableUntil: day(str(fd, "until"), true),
      backupLogin: str(fd, "backup") || null,
      note: str(fd, "note") || null,
    });
    revalidatePath("/capacity");
    return { ok: true, message: "Saved. This is shared with your team; nobody was notified or reassigned." };
  });
}
