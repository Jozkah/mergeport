import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/http";
import { normalizeEmail, userForVerifiedEmail, withUniqueRetry } from "./accounts";
import type { Mailer } from "./mailer";
import { hit } from "./rate-limit";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const HOUR = 3600 * 1000;
/** Links one address may ask for per hour, one client address may ask for per hour, and the whole server per hour. */
export const LIMITS = { perEmail: 5, perIp: 20, global: 600 } as const;

/**
 * "sent" also covers "throttled": the caller shows the same answer for both, so neither the response nor its timing says whether
 * this address was seen before or is being limited. Sign-up and sign-in are one flow (an unknown address gets an account when the
 * link is opened), so there is no existing/unknown difference to hide in the first place.
 */
export type RequestResult = "sent" | "throttled" | "invalid" | "send-failed";

export type RequestInput = {
  email: unknown;
  /** The client address as the reverse proxy reports it, or null when none is trusted. Hashed before it is stored. */
  ip?: string | null;
  /** Origin the link points at, e.g. https://app.example.com */
  origin: string;
  /** Where to land after signing in. Relative paths only. */
  next?: string | null;
  mailer: Mailer;
  now?: Date;
};

export async function requestMagicLink(db: Db, input: RequestInput): Promise<RequestResult> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!email) return "invalid";

  const okEmail = await hit(db, `auth:ml:email:${sha256(email)}`, LIMITS.perEmail, HOUR, now);
  const okIp = input.ip ? await hit(db, `auth:ml:ip:${sha256(input.ip)}`, LIMITS.perIp, HOUR, now) : true;
  const okAll = await hit(db, "auth:ml:all", LIMITS.global, HOUR, now);
  if (!okEmail || !okIp || !okAll) return "throttled";

  const token = randomToken(32);
  await db.magicLink.create({
    data: { emailLowercased: email, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS), createdAt: now, ipHash: input.ip ? sha256(`ip:${input.ip}`) : null },
  });
  // Housekeeping: links that expired a day ago are of no use to anyone.
  await db.magicLink.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * HOUR) } } });

  const next = safeReturnTo(input.next);
  const link = `${input.origin}/auth/magic/callback?token=${token}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
  try {
    await input.mailer.send({
      to: email,
      subject: "Your Mergeport sign-in link",
      text: `Open this link to sign in to Mergeport:\n\n${link}\n\nIt works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.`,
    });
  } catch {
    // The address and the link stay out of the log: only the fact that delivery failed.
    console.error("[auth] sign-in email could not be delivered");
    return "send-failed";
  }
  return "sent";
}

export type ConsumeResult = { ok: true; userId: string } | { ok: false };

/**
 * Turns a link into a user. The single UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now RETURNING is the whole
 * single-use check: of any number of simultaneous opens of one link, Postgres lets exactly one row-update through; the others
 * re-evaluate the WHERE after the winner commits, match nothing and fail. The user and identity are written in the same
 * transaction, so a failure there leaves the link usable.
 */
export async function consumeMagicLink(db: Db, token: unknown, now = new Date()): Promise<ConsumeResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false };
  const hash = sha256(token);
  return withUniqueRetry(() =>
    db.$transaction(async (tx): Promise<ConsumeResult> => {
      const rows = await tx.$queryRaw<{ emailLowercased: string }[]>`
        UPDATE "MagicLink" SET "consumedAt" = ${now}
        WHERE "tokenHash" = ${hash} AND "consumedAt" IS NULL AND "expiresAt" > ${now}
        RETURNING "emailLowercased"`;
      if (rows.length !== 1) return { ok: false };
      return { ok: true, userId: await userForVerifiedEmail(tx, rows[0].emailLowercased, now) };
    }),
  );
}
