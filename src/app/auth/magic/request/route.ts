import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { clientIp, hostedConfigProblems } from "@/lib/auth/hosted-config";
import { MailNotConfiguredError, getMailer } from "@/lib/auth/mailer";
import { MAGIC_COOKIE, MAGIC_LINK_TTL_MS, requestMagicLink } from "@/lib/auth/magic-link";
import { randomToken } from "@/lib/crypto";
import { redirectTo, sameOrigin } from "@/lib/http";
import { cookiesSecure, isHosted, originFor } from "@/lib/public-url";

/**
 * Asks for a sign-in link. Same-origin form POST; the answer is the same for known, unknown and rate-limited addresses. The browser
 * gets an HttpOnly cookie with a random value and the link is bound to it, so the link only works in this browser.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const problems = hostedConfigProblems();
  if (problems.length) {
    console.error(`[auth] sign-in is disabled: ${problems.join(" ")}`);
    return new NextResponse("Sign-in is not configured on this server.", { status: 503 });
  }
  // Hosted: the per-client limit needs an address. Without one (the proxy did not send it) refuse rather than run unlimited.
  const ip = clientIp(req);
  if (isHosted() && !ip) {
    console.error("[auth] sign-in refused: no client address in X-Forwarded-For (is the reverse proxy setting it?)");
    return new NextResponse("Sign-in is not configured on this server.", { status: 503 });
  }
  let mailer;
  try {
    mailer = await getMailer();
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return redirectTo(req, "/sign-in?error=mail-unconfigured", 303);
    throw e;
  }
  const jar = await cookies();
  const existing = jar.get(MAGIC_COOKIE)?.value;
  // One value per browser: a second request from the same browser must not orphan the link from the first.
  const nonce = existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing) ? existing : randomToken(24);
  const form = await req.formData().catch(() => null);
  const next = form?.get("next");
  const result = await requestMagicLink(db, { email: form?.get("email"), next: typeof next === "string" ? next : null, ip, browserNonce: nonce, origin: originFor(req), mailer });
  // On a failure the typed address comes back in the page's own field (never on success: the "sent" page does not repeat it).
  const typed = typeof form?.get("email") === "string" ? `&email=${encodeURIComponent(String(form?.get("email")).slice(0, 254))}` : "";
  if (result === "invalid") return redirectTo(req, `/sign-in?error=email-invalid${typed}`, 303);
  // Set for sent AND throttled alike, so the response does not tell the two apart.
  jar.set(MAGIC_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: cookiesSecure(), path: "/auth/magic", maxAge: Math.floor(MAGIC_LINK_TTL_MS / 1000) });
  if (result === "send-failed") return redirectTo(req, `/sign-in?error=mail-failed${typed}`, 303);
  return redirectTo(req, "/sign-in?sent=1", 303);
}
