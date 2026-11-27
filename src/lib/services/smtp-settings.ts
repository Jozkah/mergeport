import type { Db } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, parseKey } from "@/lib/federation/config";

/**
 * Outgoing email (SMTP), set in Settings > Email by a SERVER administrator (User.isServerAdmin), one row for the whole server. A
 * workspace owner is not enough: whoever sets this decides where everyone's sign-in links go. The password is encrypted with
 * MERGEPORT_ENCRYPTION_KEY and never leaves the server: the view only says whether one is saved.
 */

export const SETTINGS_ID = "server";
export const SMTP_SECURITY = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];
export const DEFAULT_SMTP_PORT = 587;
const AAD = "smtp:server";

export type SmtpConfig = { host: string; port: number; security: SmtpSecurity; username: string | null; password: string | null; from: string };
/** What the settings page may show. No password, ever. */
export type SmtpView = { host: string; port: number; security: SmtpSecurity; username: string; mailFrom: string; hasPassword: boolean; keyConfigured: boolean };
/** "none" = nothing saved (or incomplete); "undecryptable" = a password is saved but the current key cannot open it. */
export type SmtpLoad = { kind: "ok"; config: SmtpConfig } | { kind: "none" } | { kind: "undecryptable" };

export const smtpKey = (): Buffer | null => parseKey(process.env.MERGEPORT_ENCRYPTION_KEY);
const security = (s: string | null | undefined): SmtpSecurity => (SMTP_SECURITY as readonly string[]).includes(s ?? "") ? (s as SmtpSecurity) : "starttls";

export async function isServerAdmin(db: Db, userId: string): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { isServerAdmin: true } });
  return !!u?.isServerAdmin;
}

async function requireServerAdmin(db: Db, userId: string): Promise<void> {
  if (!(await isServerAdmin(db, userId))) throw new ForbiddenError("Only a server administrator can change outgoing email.");
}

export async function getSmtpView(db: Db): Promise<SmtpView> {
  const row = await db.serverSettings.findUnique({ where: { id: SETTINGS_ID } });
  return {
    host: row?.smtpHost ?? "",
    port: row?.smtpPort ?? DEFAULT_SMTP_PORT,
    security: security(row?.smtpSecurity),
    username: row?.smtpUsername ?? "",
    mailFrom: row?.mailFrom ?? "",
    hasPassword: !!row?.smtpPasswordEnc,
    keyConfigured: smtpKey() !== null,
  };
}

/** The saved transport, password decrypted. Incomplete settings (no host or sender) count as nothing saved. */
export async function loadSmtpConfig(db: Db): Promise<SmtpLoad> {
  const row = await db.serverSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!row?.smtpHost || !row.mailFrom) return { kind: "none" };
  let password: string | null = null;
  if (row.smtpPasswordEnc) {
    const key = smtpKey();
    password = key ? decryptSecret(row.smtpPasswordEnc, key, AAD) : null;
    if (password === null) return { kind: "undecryptable" };
  }
  return { kind: "ok", config: { host: row.smtpHost, port: row.smtpPort, security: security(row.smtpSecurity), username: row.smtpUsername || null, password, from: row.mailFrom } };
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;
const noBreaks = (s: string) => !/[\r\n\0]/.test(s);

export type SmtpInput = { host?: string; port?: string | number; security?: string; username?: string; password?: string; clearPassword?: boolean; mailFrom?: string };

/**
 * Saves the settings. A blank password keeps the saved one; `clearPassword` removes it. Without MERGEPORT_ENCRYPTION_KEY a new password
 * is refused (it would otherwise be stored in the clear). The caller's server-admin flag is re-read here, whatever the page showed.
 */
export async function saveSmtpSettings(db: Db, actorUserId: string, input: SmtpInput): Promise<void> {
  await requireServerAdmin(db, actorUserId);
  const host = (input.host ?? "").trim();
  if (!host) throw new ValidationError("Enter the SMTP server's host name, for example smtp.example.com.");
  if (!HOST.test(host)) throw new ValidationError("That host name is not valid. Use only the name, for example smtp.example.com, without smtp:// or a port.");
  const portRaw = String(input.port ?? "").trim();
  const port = portRaw === "" ? DEFAULT_SMTP_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("The port must be a number from 1 to 65535.");
  if (!(SMTP_SECURITY as readonly string[]).includes(input.security ?? "")) throw new ValidationError("Choose how the connection is secured.");
  const username = (input.username ?? "").trim();
  if (username.length > 254 || !noBreaks(username)) throw new ValidationError("The user name is not valid.");
  const mailFrom = (input.mailFrom ?? "").trim();
  if (!mailFrom) throw new ValidationError("Enter the sender address, for example Mergeport <no-reply@example.com>.");
  if (mailFrom.length > 320 || !noBreaks(mailFrom) || !/@/.test(mailFrom)) throw new ValidationError("The sender address is not valid. Use an address, optionally with a name: Mergeport <no-reply@example.com>.");
  const password = input.password ?? "";
  if (!noBreaks(password) || password.length > 1024) throw new ValidationError("The password is not valid.");
  let enc: string | null | undefined;
  if (input.clearPassword) enc = null;
  else if (password) {
    const key = smtpKey();
    if (!key) throw new ValidationError("A password cannot be saved: MERGEPORT_ENCRYPTION_KEY is not set on this server, and passwords are only stored encrypted.");
    enc = encryptSecret(password, key, AAD);
  }
  const data = { smtpHost: host, smtpPort: port, smtpSecurity: input.security as SmtpSecurity, smtpUsername: username || null, mailFrom, updatedById: actorUserId };
  await db.serverSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data, smtpPasswordEnc: enc ?? null },
    update: { ...data, ...(enc !== undefined ? { smtpPasswordEnc: enc } : {}) },
  });
}
