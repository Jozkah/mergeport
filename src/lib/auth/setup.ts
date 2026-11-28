import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { loadSmtpConfig } from "@/lib/services/smtp-settings";
import { loginFromEmail, normalizeEmail } from "./accounts";

/**
 * The first server administrator (User.isServerAdmin). A fresh hosted server has no outgoing email yet, so nobody could sign in by
 * email to set it up. While nobody is server administrator, every start of the web server (scripts/start.ts) makes ONE new setup
 * link, valid 24 hours and once, and prints it to the server log; earlier links stop working. Only the SHA-256 of the token is stored.
 * Opening it lets the person name the administrator (or make themselves administrator if they are already signed in). Once someone
 * holds the flag no link is made and any unused one is refused.
 */

export const SETUP_TTL_MS = 24 * 3600 * 1000;
export const SETUP_PATH = "/setup";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

export const serverAdminExists = async (db: Db) => (await db.user.count({ where: { isServerAdmin: true } })) > 0;

/** A new setup token (replacing every earlier one), or null when a server administrator already exists. */
export async function issueSetupToken(db: Db, now = new Date()): Promise<string | null> {
  const token = randomToken(32);
  return db.$transaction(async (tx) => {
    await tx.setupToken.deleteMany({});
    if ((await tx.user.count({ where: { isServerAdmin: true } })) > 0) return null;
    await tx.setupToken.create({ data: { tokenHash: sha256(token), expiresAt: new Date(now.getTime() + SETUP_TTL_MS) } });
    return token;
  });
}

/**
 * The recovery link: a server administrator exists but outgoing email does not work (never set up, or the saved password cannot be
 * decrypted with the current MERGEPORT_ENCRYPTION_KEY), so they could never get back in by email once signed out. Same rules as the
 * setup link (one per start, earlier ones dead, 24 hours, once, hash only); it signs this browser in as the server administrator.
 */
export async function issueRecoveryToken(db: Db, now = new Date()): Promise<string | null> {
  const token = randomToken(32);
  return db.$transaction(async (tx) => {
    await tx.setupToken.deleteMany({});
    if ((await tx.user.count({ where: { isServerAdmin: true } })) === 0) return null;
    await tx.setupToken.create({ data: { tokenHash: sha256(token), purpose: "recovery", expiresAt: new Date(now.getTime() + SETUP_TTL_MS) } });
    return token;
  });
}

/**
 * Called once at server start (hosted only). Prints one log line: the setup link while nobody is server administrator, otherwise the
 * recovery link while outgoing email does not work, otherwise nothing.
 */
export async function announceSetupLink(db: Db, origin: string, log: (line: string) => void = (l) => console.log(l), now = new Date()): Promise<string | null> {
  const base = origin.replace(/\/+$/, "");
  const token = await issueSetupToken(db, now);
  if (token) {
    log(`Mergeport setup: open ${base}${SETUP_PATH}/${token} to create the server administrator.`);
    return token;
  }
  if ((await loadSmtpConfig(db)).kind === "ok") return null;
  const recovery = await issueRecoveryToken(db, now);
  if (recovery) log(`Mergeport admin sign-in: email is not working, so nobody can sign in by email. Open ${base}${SETUP_PATH}/${recovery} to sign in as the server administrator and fix Settings > Email (works once, for 24 hours).`);
  return recovery;
}

/** What a link is for while it can still be used, or null: known, unused, unexpired, and (setup) nobody is administrator yet or (recovery) somebody is. */
export async function setupLinkKind(db: Db, token: unknown, now = new Date()): Promise<"setup" | "recovery" | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const row = await db.setupToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt <= now) return null;
  const admin = await serverAdminExists(db);
  if (row.purpose === "recovery") return admin ? "recovery" : null;
  return admin ? null : "setup";
}

/** True when the setup link can still be used to name the first administrator. */
export async function setupTokenValid(db: Db, token: unknown, now = new Date()): Promise<boolean> {
  return (await setupLinkKind(db, token, now)) === "setup";
}

/** Uses a recovery link (once) and answers the server administrator to sign in as (the earliest, if several), or null. */
export async function claimRecovery(db: Db, token: unknown, now = new Date()): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  return db.$transaction(async (tx) => {
    const used = await tx.setupToken.updateMany({ where: { tokenHash: sha256(token), purpose: "recovery", usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return null;
    const admin = await tx.user.findFirst({ where: { isServerAdmin: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
    return admin?.id ?? null;
  });
}

export type SetupClaim = { token: unknown; email?: unknown; name?: unknown; /** The signed-in person who makes THEMSELVES administrator. */ userId?: string | null };
export type SetupResult = { ok: true; userId: string; created: boolean } | { ok: false; reason: "invalid" | "email-invalid" };

/**
 * Uses the token (once: a conditional update that only one caller can win) and makes the chosen person server administrator, in one
 * transaction with the "nobody is administrator yet" check. A typed address that matches no account creates one, unverified (the
 * inbox is proven later, by the first email sign-in); a matching account is reused. Either way it gets no email identity here.
 */
export async function claimSetup(db: Db, claim: SetupClaim, now = new Date()): Promise<SetupResult> {
  if (typeof claim.token !== "string" || !TOKEN_SHAPE.test(claim.token)) return { ok: false, reason: "invalid" };
  const email = claim.userId ? null : normalizeEmail(claim.email);
  if (!claim.userId && !email) return { ok: false, reason: "email-invalid" };
  const name = typeof claim.name === "string" && claim.name.trim() ? claim.name.trim().slice(0, 100) : null;
  const tokenHash = sha256(claim.token);
  return db.$transaction(async (tx): Promise<SetupResult> => {
    const used = await tx.setupToken.updateMany({ where: { tokenHash, purpose: "setup", usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return { ok: false, reason: "invalid" };
    if ((await tx.user.count({ where: { isServerAdmin: true } })) > 0) return { ok: false, reason: "invalid" };
    if (claim.userId) {
      const u = await tx.user.update({ where: { id: claim.userId }, data: { isServerAdmin: true }, select: { id: true } });
      return { ok: true, userId: u.id, created: false };
    }
    const holder = await tx.user.findUnique({ where: { email: email! }, select: { id: true, name: true } });
    if (holder) {
      await tx.user.update({ where: { id: holder.id }, data: { isServerAdmin: true, ...(name && !holder.name ? { name } : {}) } });
      return { ok: true, userId: holder.id, created: false };
    }
    const u = await tx.user.create({ data: { login: loginFromEmail(email!), email: email!, name, isServerAdmin: true }, select: { id: true } });
    return { ok: true, userId: u.id, created: true };
  });
}
