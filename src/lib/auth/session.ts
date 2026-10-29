import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";

export const SESSION_COOKIE = "mp_session";
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

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
