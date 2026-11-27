import nodemailer from "nodemailer";
import { db as defaultDb, type Db } from "@/lib/db";
import { publicOrigin } from "@/lib/public-url";
import { loadSmtpConfig, type SmtpConfig } from "@/lib/services/smtp-settings";

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Production with no outgoing email saved in Settings > Email. Sign-in by email is unavailable; nothing is logged or silently dropped. */
export class MailNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`Email sign-in is not configured: ${detail}`);
    this.name = "MailNotConfiguredError";
  }
}

/** Development only: prints the message (and so the sign-in link) to the server console instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {
    if (process.env.NODE_ENV === "production" || publicOrigin()?.protocol === "https:") throw new MailNotConfiguredError("the console mail transport is never used in production or on an https deployment");
  }
  async send(msg: MailMessage): Promise<void> {
    this.log(`[dev mail] to ${msg.to}\n${msg.subject}\n${msg.text}`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  private readonly from: string;
  constructor(cfg: SmtpConfig) {
    this.from = cfg.from;
    // starttls: plain connect, then STARTTLS is required (port 587). tls: TLS from the first byte (port 465). none: never upgrade.
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === "tls",
      requireTLS: cfg.security === "starttls",
      ignoreTLS: cfg.security === "none",
      ...(cfg.username ? { auth: { user: cfg.username, pass: cfg.password ?? "" } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

let override: Mailer | null = null;
/** Tests inject a recording mailer. Also forgets the cached settings. */
export function setMailerForTests(m: Mailer | null) {
  override = m;
  invalidateMailerCache();
}

const CACHE_MS = 30_000;
let cached: { at: number; load: Awaited<ReturnType<typeof loadSmtpConfig>> } | null = null;
/** Called when Settings > Email is saved, so the next message uses the new settings at once (this process; others within 30 s). */
export function invalidateMailerCache() {
  cached = null;
}

/**
 * Outgoing email comes from Settings > Email (a server administrator saves it; read here with a 30-second cache). Without it,
 * development logs links to the console; production throws MailNotConfiguredError so the sign-in page can say so, rather than
 * printing sign-in links into server logs.
 */
export async function getMailer(db: Db = defaultDb): Promise<Mailer> {
  if (override) return override;
  if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), load: await loadSmtpConfig(db) };
  const load = cached.load;
  if (load.kind === "ok") return new SmtpMailer(load.config);
  if (load.kind === "undecryptable") throw new MailNotConfiguredError("the saved SMTP password cannot be decrypted with MERGEPORT_ENCRYPTION_KEY; save it again in Settings > Email");
  if (process.env.NODE_ENV === "production") throw new MailNotConfiguredError("outgoing email is not set up in Settings > Email");
  // A hosted deployment on https is a real service whatever NODE_ENV says: no links in the server log. The console transport remains for
  // local development and for a hosted trial on plain http (for example MERGEPORT_PUBLIC_URL=http://127.0.0.1:3000).
  if (publicOrigin()?.protocol === "https:") throw new MailNotConfiguredError("outgoing email is not set up in Settings > Email (the console transport is not used for an https deployment)");
  return new ConsoleMailer();
}

/** True when sending would work, without sending anything. The sign-in page uses it to hide the email form with an explanation. */
export async function mailConfigured(db: Db = defaultDb): Promise<boolean> {
  try {
    await getMailer(db);
    return true;
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return false;
    throw e;
  }
}
