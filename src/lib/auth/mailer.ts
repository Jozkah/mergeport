import nodemailer from "nodemailer";

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Production without SMTP_URL / MAIL_FROM. Sign-in by email is unavailable; nothing is logged or silently dropped. */
export class MailNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`Email sign-in is not configured: ${detail}`);
    this.name = "MailNotConfiguredError";
  }
}

/** Development only: prints the message (and so the sign-in link) to the server console instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {
    if (process.env.NODE_ENV === "production") throw new MailNotConfiguredError("the console mail transport is never used in production");
  }
  async send(msg: MailMessage): Promise<void> {
    this.log(`[dev mail] to ${msg.to}\n${msg.subject}\n${msg.text}`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(smtpUrl: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

let override: Mailer | null = null;
/** Tests inject a recording mailer. */
export function setMailerForTests(m: Mailer | null) {
  override = m;
}

/**
 * SMTP_URL (with MAIL_FROM) configures real delivery. Without it, development logs links to the console; production throws
 * MailNotConfiguredError so the sign-in page can say so, rather than printing sign-in links into server logs.
 */
export function getMailer(): Mailer {
  if (override) return override;
  const url = process.env.SMTP_URL?.trim();
  if (url) {
    const from = process.env.MAIL_FROM?.trim();
    if (!from) throw new MailNotConfiguredError("MAIL_FROM is not set");
    return new SmtpMailer(url, from);
  }
  if (process.env.NODE_ENV === "production") throw new MailNotConfiguredError("SMTP_URL is not set");
  return new ConsoleMailer();
}

/** True when sending would work, without sending anything. The sign-in page uses it to hide the email form with an explanation. */
export function mailConfigured(): boolean {
  try {
    getMailer();
    return true;
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return false;
    throw e;
  }
}
