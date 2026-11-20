import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";

export const SESSION_COOKIE = "mp_session";
/** The app listens on this computer only and the cookie is the person's own browser, so the sign-in lasts half a year (browsers cap cookies near 400 days). It used to be 14 days, which meant signing in again every two weeks. */
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;

/** Opaque server-side session. Only the SHA-256 of the cookie value is stored. */
export async function createSession(db: Db, userId: string, now = new Date()) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.session.create({ data: { tokenHash: sha256(token), csrfToken: randomToken(16), userId, expiresAt } });
  return { token, expiresAt };
}

export async function findSession(db: Db, token: string | undefined | null, now = new Date()) {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt <= now) return null;
  return s;
}

export async function destroySession(db: Db, token: string | undefined | null) {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}
