import type { Db } from "@/lib/db";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/http";
import { normalizeEmail, userForVerifiedEmail, withUniqueRetry } from "./accounts";
import type { Mailer } from "./mailer";
import { claimGap, take } from "./rate-limit";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** Name of the HttpOnly cookie that holds the requesting browser's random value. */
export const MAGIC_COOKIE = "mp_ml";
const HOUR = 3600 * 1000;
/**
 * perIp: mails one client address may trigger per hour (any addresses). perEmailIp: per (address, client) pair, so one client cannot
 * use up a victim's budget for anyone else. gapMs: at most one mail per address per gap, whoever asks. global: a backstop only;
 * it is counted AFTER the per-client check, so one client can use at most perIp of it.
 */
export const LIMITS = { perIp: 20, perEmailIp: 5, global: 2000, gapMs: 60_000 } as const;

/**
 * "sent" also covers "throttled": the caller shows the same answer for both, so neither the response nor its timing says whether
 * this address was seen before or is being limited. Sign-up and sign-in are one flow (an unknown address gets an account when the
 * link is opened), so there is no existing/unknown difference to hide in the first place.
 */
export type RequestResult = "sent" | "throttled" | "invalid" | "send-failed";

export type RequestInput = {
  email: unknown;
  /** The client address from the trusted proxy, or null when none is known (library callers and tests). Hashed before it is stored. */
  ip?: string | null;
  /** Random value from the requesting browser's cookie. Only its hash is stored; the link works only where the cookie is present. */
  browserNonce: string;
  /** Origin the link points at, e.g. https://app.example.com */
  origin: string;
  /** Where to land after signing in. Relative paths only. */
  next?: string | null;
  mailer: Mailer;
  now?: Date;
};

let lastCleanup = 0;
let warnedGlobalAt = 0;

export async function requestMagicLink(db: Db, input: RequestInput): Promise<RequestResult> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!email || input.browserNonce.length < 16) return "invalid";

  const ip = input.ip ?? "none";
  // Order matters: each step is only reached when the cheaper-to-abuse one before it passed, and a refused step counts nothing.
  if (input.ip && !(await take(db, `auth:ml:ip:${sha256(input.ip)}`, LIMITS.perIp, HOUR, now))) return "throttled";
  if (!(await take(db, "auth:ml:all", LIMITS.global, HOUR, now))) {
    if (Date.now() - warnedGlobalAt > HOUR) {
      warnedGlobalAt = Date.now();
      console.error("[auth] server-wide sign-in email limit reached; requests are being refused");
    }
    return "throttled";
  }
  // The (address, client) budget comes BEFORE the spacing slot: a client that has used up its own budget for an address is refused here
  // without touching the slot, so it cannot keep the slot occupied (and the real owner shut out) by calling again every minute.
  if (!(await take(db, `auth:ml:ei:${sha256(`${email}|${ip}`)}`, LIMITS.perEmailIp, HOUR, now))) return "throttled";
  if (!(await claimGap(db, `auth:ml:gap:${sha256(email)}`, LIMITS.gapMs, now))) return "throttled";

  const token = randomToken(32);
  await db.magicLink.create({
    data: { emailLowercased: email, tokenHash: sha256(token), browserHash: sha256(input.browserNonce), expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS), createdAt: now, ipHash: input.ip ? sha256(`ip:${input.ip}`) : null },
  });
  // Housekeeping: links that expired a day ago are of no use to anyone. At most once a minute per process; the expiresAt index makes it cheap.
  if (Date.now() - lastCleanup > 60_000) {
    lastCleanup = Date.now();
    await db.magicLink.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * HOUR) } } });
  }

  const next = safeReturnTo(input.next);
  const link = `${input.origin}/auth/magic/callback?token=${token}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
  try {
    await input.mailer.send({
      to: email,
      subject: "Your Mergeport sign-in link",
      text: `Open this link, in the same browser you asked from, to sign in to Mergeport:\n\n${link}\n\nIt works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.`,
    });
  } catch {
    // The address and the link stay out of the log: only the fact that delivery failed.
    console.error("[auth] sign-in email could not be delivered");
    return "send-failed";
  }
  return "sent";
}

/** `browser`: the link is fine but this browser is not the one that asked for it. The link is left unused. */
export type ConsumeResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "browser" };

/**
 * Turns a link into a user. The link must be opened in the browser that requested it (its cookie value hashes to the stored
 * `browserHash`); otherwise nothing is consumed, so a link planted in a victim's browser (login CSRF) or opened first by a mail
 * scanner (no cookie) does not burn it. The single UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now AND browserHash = ...
 * RETURNING is the whole single-use check: of any number of simultaneous opens, Postgres lets exactly one through. The user and
 * identity are written in the same transaction, so a failure there leaves the link usable.
 */
export async function consumeMagicLink(db: Db, token: unknown, browserNonce: string | undefined | null, now = new Date()): Promise<ConsumeResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  const hash = sha256(token);
  const mine = browserNonce ? sha256(browserNonce) : "";
  return withUniqueRetry(() =>
    db.$transaction(async (tx): Promise<ConsumeResult> => {
      const row = await tx.magicLink.findUnique({ where: { tokenHash: hash }, select: { browserHash: true, consumedAt: true, expiresAt: true } });
      if (!row || row.consumedAt || row.expiresAt <= now) return { ok: false, reason: "invalid" };
      if (!row.browserHash || !mine || !safeEqual(row.browserHash, mine)) return { ok: false, reason: "browser" };
      const rows = await tx.$queryRaw<{ emailLowercased: string }[]>`
        UPDATE "MagicLink" SET "consumedAt" = ${now}
        WHERE "tokenHash" = ${hash} AND "browserHash" = ${mine} AND "consumedAt" IS NULL AND "expiresAt" > ${now}
        RETURNING "emailLowercased"`;
      if (rows.length !== 1) return { ok: false, reason: "invalid" };
      return { ok: true, userId: await userForVerifiedEmail(tx, rows[0].emailLowercased, now) };
    }),
  );
}
