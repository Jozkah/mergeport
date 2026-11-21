import type { Prisma } from "@/generated/prisma/client";

/** Find-or-create of the person behind an email or OIDC login. Pure database logic; docs/auth.md explains the linking rules. */
type Tx = Prisma.TransactionClient;

const LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercased, trimmed address, or null when it is not a plain ASCII address. Plus-addressing is NOT stripped: a+b@x.com and
 * a@x.com are different mailboxes as far as we can prove, and stripping would merge accounts on a guess.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  const at = e.lastIndexOf("@");
  if (at < 1 || e.indexOf("@") !== at) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!LOCAL.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!DOMAIN.test(domain)) return null;
  return e;
}

/** A display handle for someone with no GitHub login: the part before the @, reduced to safe characters. Not unique, not an identifier. */
export function loginFromEmail(email: string): string {
  const base = email.split("@")[0].replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 39);
  return base || "user";
}

/** True for the unique-constraint error two racing first sign-ins can hit. The caller retries once and finds the winner's row. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

export async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return fn();
  }
}

/**
 * The user for an email whose owner just opened a magic link (so the inbox is proven). An existing account holding the address
 * gets an `email` identity; otherwise a new account is made.
 */
export async function userForVerifiedEmail(tx: Tx, email: string, now: Date): Promise<string> {
  const known = await tx.identity.findUnique({ where: { provider_subject: { provider: "email", subject: email } }, select: { userId: true } });
  if (known) return known.userId;
  const holder = await tx.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  if (holder) {
    await tx.identity.create({ data: { userId: holder.id, provider: "email", subject: email, email } });
    if (!holder.emailVerifiedAt) await tx.user.update({ where: { id: holder.id }, data: { emailVerifiedAt: now } });
    return holder.id;
  }
  const u = await tx.user.create({
    data: { login: loginFromEmail(email), email, emailVerifiedAt: now, identities: { create: { provider: "email", subject: email, email } } },
    select: { id: true },
  });
  return u.id;
}

export type OidcClaims = { sub: string; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown };

/** Providers disagree on the type of email_verified: Google sends a boolean, a few send the string "true". Anything else is NOT verified. */
export function claimsEmailVerified(c: OidcClaims): boolean {
  return c.email_verified === true || c.email_verified === "true";
}

export type OidcLogin = { userId: string; created: boolean; linked: boolean };

/**
 * Resolves an OIDC login to a user.
 *  1. The provider's own subject is already known: that user, always. The email is never consulted.
 *  2. The provider asserts a VERIFIED email that an existing user holds:
 *       - the holder verified it too: the new identity is attached to the holder;
 *       - the holder never verified it (an address someone typed in, not proved): that claim is stale. It is removed from the
 *         holder and a new user, who has proved the address, takes it. Merging would let whoever registered an address first
 *         own the real owner's later logins.
 *  3. No verified email (unverified, missing, or a provider such as Microsoft that does not send email_verified): a new user
 *     with no email. The address is kept on the identity for display only and is never used for linking.
 */
export async function userForOidcLogin(tx: Tx, providerName: string, claims: OidcClaims, now: Date): Promise<OidcLogin> {
  const provider = `oidc:${providerName}`;
  const subject = claims.sub;
  const rawEmail = typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 120) : null;
  const picture = typeof claims.picture === "string" && /^https:\/\//.test(claims.picture) ? claims.picture.slice(0, 500) : null;

  const known = await tx.identity.findUnique({ where: { provider_subject: { provider, subject } }, select: { id: true, userId: true } });
  if (known) {
    if (rawEmail) await tx.identity.update({ where: { id: known.id }, data: { email: rawEmail } });
    return { userId: known.userId, created: false, linked: false };
  }

  const verified = rawEmail && claimsEmailVerified(claims) ? rawEmail : null;
  if (verified) {
    const holder = await tx.user.findUnique({ where: { email: verified }, select: { id: true, emailVerifiedAt: true } });
    if (holder?.emailVerifiedAt) {
      await tx.identity.create({ data: { userId: holder.id, provider, subject, email: verified } });
      return { userId: holder.id, created: false, linked: true };
    }
    if (holder) await tx.user.update({ where: { id: holder.id }, data: { email: null } });
  }
  const u = await tx.user.create({
    data: {
      login: loginFromEmail(rawEmail ?? "user@x.invalid"),
      name,
      avatarUrl: picture,
      email: verified,
      emailVerifiedAt: verified ? now : null,
      identities: { create: { provider, subject, email: rawEmail } },
    },
    select: { id: true },
  });
  return { userId: u.id, created: true, linked: false };
}
