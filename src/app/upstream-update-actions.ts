"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer, requireWriter } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { markReleasesSeen, requestUpdateRun, saveUpdateConfig } from "@/lib/services/upstream-update";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Authorization is in the service: an administrator of this profile, for a mapping they can see. */
export async function saveUpdateConfigAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const c = await saveUpdateConfig(db, viewer, str(fd, "mappingId"), { mode: str(fd, "mode"), enabled: fd.get("enabled") === "on", verifyCommand: str(fd, "verifyCommand"), promote: str(fd, "promote"), timeoutSec: str(fd, "timeoutSec"), branchName: str(fd, "branchName"), includePrereleases: str(fd, "mode") === "releases" ? fd.get("includePrereleases") === "on" : undefined });
    if (c.enabled && c.mode === "releases") void import("@/lib/local/scheduler").then((m) => m.runJobsNow()).catch(() => {}); // the baseline is recorded now
    revalidatePath("/forks");
    if (!c.enabled) return { ok: true, message: "Saved. Auto-update is off." };
    return { ok: true, message: c.mode === "releases" ? "Watching for new upstream releases. Mergeport only reads them and tells you; it changes nothing." : "Auto-update is on. It checks after each comparison of this fork." };
  });
}

export async function runUpdateNowAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await requestUpdateRun(db, viewer, str(fd, "mappingId"));
    void import("@/lib/local/scheduler").then((m) => m.runJobsNow()).catch(() => {});
    revalidatePath("/forks");
    return { ok: true, message: "Queued. The run starts in the background and appears in the history below." };
  });
}

/** The Forks page was opened: the release warnings it shows have been seen (they leave the daily digest). No page refresh: nothing here changes what is drawn. */
export async function markReleasesSeenAction(mappingId: string): Promise<void> {
  try {
    const { viewer } = await requireViewer();
    await markReleasesSeen(db, viewer, String(mappingId).slice(0, 64));
  } catch (e) {
    unstable_rethrow(e); // an ended session still goes to sign-in
    /* looking at a page must never fail because of this */
  }
}
