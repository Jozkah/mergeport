"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, type ActionResult } from "@/lib/action-result";
import { getAuth } from "@/lib/auth/current";
import { SmtpMailer, invalidateMailerCache } from "@/lib/auth/mailer";
import { isDemo } from "@/lib/env";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { isHosted } from "@/lib/public-url";
import { isServerAdmin, loadSmtpConfig, saveSmtpSettings } from "@/lib/services/smtp-settings";

// Settings > Email is server-wide, so these check the SERVER administrator flag (User.isServerAdmin), not a workspace role:
// a workspace owner must not be able to redirect everyone's sign-in links.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

async function serverAdmin() {
  if (!isHosted() || isDemo()) throw new ForbiddenError("Outgoing email is set up on a hosted server only.");
  const a = await getAuth();
  if (!a) throw new UnauthenticatedError();
  if (!(await isServerAdmin(db, a.user.id))) throw new ForbiddenError("Only a server administrator can change outgoing email.");
  return a.user;
}

export async function saveSmtpSettingsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const user = await serverAdmin();
    await saveSmtpSettings(db, user.id, { host: str(fd, "host"), port: str(fd, "port"), security: str(fd, "security"), username: str(fd, "username"), password: str(fd, "password"), clearPassword: fd.get("clearPassword") === "on", mailFrom: str(fd, "mailFrom") });
    invalidateMailerCache();
    // Server-wide, so not in a workspace's audit log: the server log records who changed it (never the values).
    console.info(`[settings] outgoing email settings changed by user ${user.id}`);
    revalidatePath("/settings/email");
    return { ok: true, message: "Saved" };
  });
}

/** Sends one message to the administrator's own address with the SAVED settings, and reports the SMTP server's error text on failure. */
export async function sendTestEmailAction(): Promise<ActionResult> {
  return run(async () => {
    const user = await serverAdmin();
    if (!user.email) throw new ValidationError("Your account has no email address to send the test to.");
    const load = await loadSmtpConfig(db);
    if (load.kind === "none") throw new ValidationError("Save the settings first.");
    if (load.kind === "undecryptable") throw new ValidationError("The saved password cannot be decrypted with this server's MERGEPORT_ENCRYPTION_KEY. Enter it again and save.");
    try {
      await new SmtpMailer(load.config).send({ to: user.email, subject: "Mergeport test email", text: "Outgoing email works. Sign-in links and invitations from this server will be sent the same way." });
    } catch (e) {
      return { ok: false, error: `Sending failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, message: `Test email sent to ${user.email}` };
  });
}
