"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { isDay } from "@/lib/domain/digest";
import { ValidationError } from "@/lib/errors";
import { generateDigest, markDigestRead } from "@/lib/services/digest";
import { getPrefs, setPrefs } from "@/lib/services/notification-prefs";

/** Everything here is personal and local: nothing is sent to GitHub or to teammates. */

export async function regenerateDigestAction(day: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!isDay(day)) throw new ValidationError("That is not a day");
    await generateDigest(db, viewer, { day, replace: true });
    revalidatePath("/digest");
    revalidatePath("/");
    return { ok: true, message: "Digest rebuilt from the data on this computer" };
  });
}

export async function markDigestReadAction(day: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!isDay(day)) throw new ValidationError("That is not a day");
    await markDigestRead(db, viewer.userId, day);
    revalidatePath("/digest");
    revalidatePath("/");
    return { ok: true };
  });
}

/** The digest switch and the local hour after which it is made. The hour is a whole number from 0 to 23 on the local clock. */
export async function saveDigestSettingsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const raw = String(fd.get("hour") ?? "").trim();
    const hour = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ValidationError("Enter a whole hour from 0 to 23.");
    const cur = await getPrefs(db, viewer.userId);
    await setPrefs(db, viewer.userId, { ...cur, digest: { enabled: fd.get("enabled") === "on" || fd.get("enabled") === "true", hour } });
    revalidatePath("/settings");
    return { ok: true, message: "Saved" };
  });
}
