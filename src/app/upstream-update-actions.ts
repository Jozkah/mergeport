"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { requestUpdateRun, saveUpdateConfig } from "@/lib/services/upstream-update";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Authorization is in the service: an administrator of this profile, for a mapping they can see. */
export async function saveUpdateConfigAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const c = await saveUpdateConfig(db, viewer, str(fd, "mappingId"), { enabled: fd.get("enabled") === "on", verifyCommand: str(fd, "verifyCommand"), promote: str(fd, "promote"), timeoutSec: str(fd, "timeoutSec"), branchName: str(fd, "branchName") });
    revalidatePath("/forks");
    return { ok: true, message: c.enabled ? "Auto-update is on. It checks after each comparison of this fork." : "Saved. Auto-update is off." };
  });
}

export async function runUpdateNowAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await requestUpdateRun(db, viewer, str(fd, "mappingId"));
    void import("@/lib/local/scheduler").then((m) => m.runJobsNow()).catch(() => {});
    revalidatePath("/forks");
    return { ok: true, message: "Queued. The run starts in the background and appears in the history below." };
  });
}
