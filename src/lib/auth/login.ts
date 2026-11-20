import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { safeReturnTo } from "@/lib/http";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, destroySession, hostedSessionCookie } from "./session";

/**
 * Starts the browser session after a verified sign-in. Always a NEW session token (session fixation): whatever session cookie the
 * browser sent before is destroyed on the server first, so a token planted in the browser earlier is worthless.
 */
export async function startHostedSession(userId: string): Promise<void> {
  const jar = await cookies();
  await destroySession(db, jar.get(SESSION_COOKIE)?.value);
  const s = await createSession(db, userId);
  // The browser cookie outlives the server-side expiry on purpose: the server's sliding expiry decides, and a cookie that expired on
  // the original date would end a session the server has since renewed.
  jar.set(SESSION_COOKIE, s.token, hostedSessionCookie(new Date(Date.now() + SESSION_TTL_MS)));
}

/** Where a freshly signed-in person goes: the page they asked for, or onboarding when they belong to no workspace yet. */
export async function landingPath(userId: string, next?: string | null): Promise<string> {
  const n = await db.member.count({ where: { userId, status: "ACTIVE" } });
  return n === 0 ? "/onboarding" : safeReturnTo(next);
}
