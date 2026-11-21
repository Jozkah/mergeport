import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { cookiesSecure, isHosted } from "@/lib/public-url";

export const SESSION_COOKIE = "mp_session";
/** The app listens on this computer only and the cookie is the person's own browser, so the sign-in lasts half a year (browsers cap cookies near 400 days). It used to be 14 days, which meant signing in again every two weeks. */
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
/** A hosted session lasts this long after its last use (MERGEPORT_SESSION_DAYS, 1 to 180; default 30), and never past SESSION_TTL_MS from sign-in. */
export const HOSTED_SESSION_DEFAULT_DAYS = 30;
/** A sliding session is extended at most this often, so a busy tab is not one database write per request. */
export const RENEW_EVERY_MS = 3600 * 1000;

/** The idle lifetime of a new or renewed session: the local app's fixed 180 days, or the hosted sliding window. */
export function sessionTtlMs(): number {
  if (!isHosted()) return SESSION_TTL_MS;
  const raw = process.env.MERGEPORT_SESSION_DAYS?.trim() ?? "";
  const d = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  const days = d >= 1 && d <= 180 ? d : HOSTED_SESSION_DEFAULT_DAYS;
  return days * 24 * 3600 * 1000;
}

/** Opaque server-side session. Only the SHA-256 of the cookie value is stored. */
export async function createSession(db: Db, userId: string, now = new Date(), activeWorkspaceId: string | null = null) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + sessionTtlMs());
  await db.session.create({ data: { tokenHash: sha256(token), csrfToken: randomToken(16), userId, expiresAt, activeWorkspaceId } });
  return { token, expiresAt };
}

/**
 * Cookie attributes for hosted sign-in: HttpOnly, SameSite=Lax (the magic link and the OIDC redirect arrive as top-level
 * navigations from another site, and Strict would hide the cookie on the very next request), Secure when the public address is https.
 */
export const hostedSessionCookie = (expires: Date) => ({ httpOnly: true, sameSite: "lax" as const, secure: cookiesSecure(), path: "/", expires });

/**
 * The live session for a cookie value, or null. On a hosted deployment a session in use slides forward: its expiry moves to now plus
 * the idle window, at most once an hour and never beyond SESSION_TTL_MS after sign-in. The update only applies to the expiry this call
 * read, so two requests renewing together write once. The local app's sessions stay fixed.
 */
export async function findSession(db: Db, token: string | undefined | null, now = new Date()) {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt <= now) return null;
  if (isHosted()) {
    const target = new Date(Math.min(now.getTime() + sessionTtlMs(), s.createdAt.getTime() + SESSION_TTL_MS));
    if (target.getTime() - s.expiresAt.getTime() >= RENEW_EVERY_MS) {
      const r = await db.session.updateMany({ where: { id: s.id, expiresAt: s.expiresAt }, data: { expiresAt: target } });
      if (r.count === 1) s.expiresAt = target;
    }
  }
  return s;
}

export async function destroySession(db: Db, token: string | undefined | null) {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

/** Ends every login of a person on every device. */
export async function destroyAllSessions(db: Db, userId: string): Promise<number> {
  return (await db.session.deleteMany({ where: { userId } })).count;
}
