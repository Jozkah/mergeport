import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { safeReturnTo } from "@/lib/http";
import { SESSION_COOKIE, createSession, destroySession, hostedSessionCookie } from "./session";

/**
 * Starts the browser session after a verified sign-in. Always a NEW session token (session fixation): whatever session cookie the
 * browser sent before is destroyed on the server first, so a token planted in the browser earlier is worthless.
 */
export async function startHostedSession(userId: string): Promise<void> {
  const jar = await cookies();
  await destroySession(db, jar.get(SESSION_COOKIE)?.value);
  const s = await createSession(db, userId);
  jar.set(SESSION_COOKIE, s.token, hostedSessionCookie(s.expiresAt));
}

/** Where a freshly signed-in person goes: the page they asked for, or onboarding when they belong to no workspace yet. */
export async function landingPath(userId: string, next?: string | null): Promise<string> {
  const n = await db.member.count({ where: { userId, status: "ACTIVE" } });
  return n === 0 ? "/onboarding" : safeReturnTo(next);
}

/**
 * The client address for per-address limits. Only a reverse proxy we are told to trust may name it (MERGEPORT_TRUST_PROXY=true):
 * the LAST X-Forwarded-For entry is the one that proxy appended, the earlier ones are whatever the client claimed. With no trusted
 * proxy there is no reliable address and the per-address limit is skipped; the per-email and server-wide limits still apply.
 */
export function clientIp(req: Request): string | null {
  if (process.env.MERGEPORT_TRUST_PROXY !== "true") return null;
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const last = xff.split(",").at(-1)?.trim();
  return last || null;
}
