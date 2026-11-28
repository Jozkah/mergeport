import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { isDemo } from "@/lib/env";
import { clientIp, hostedConfigProblems } from "@/lib/auth/hosted-config";
import { landingPath, startHostedSession } from "@/lib/auth/login";
import { take } from "@/lib/auth/rate-limit";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { SETUP_PATH, claimRecovery, claimSetup } from "@/lib/auth/setup";
import { redirectTo, sameOrigin } from "@/lib/http";
import { isHosted } from "@/lib/public-url";

const RATE_MAX = 10;
const RATE_WINDOW_MS = 15 * 60_000;
const notFound = () => new NextResponse("Not found", { status: 404 });

/**
 * The setup form (src/app/setup/[token]/page.tsx) posts here. Same-origin form POST, rate limited per client address. With `mode=me`
 * the signed-in person becomes server administrator and keeps their session; otherwise the typed address does, and this browser is
 * signed in as that person with a new session. A used, expired or unknown link, or one opened after an administrator exists, is a 404.
 */
export async function POST(req: Request) {
  if (!isHosted() || isDemo()) return notFound();
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const problems = hostedConfigProblems();
  if (problems.length) {
    console.error(`[auth] setup is disabled: ${problems.join(" ")}`);
    return new NextResponse("Sign-in is not configured on this server.", { status: 503 });
  }
  const ip = clientIp(req);
  if (!ip) {
    console.error("[auth] setup refused: no client address in X-Forwarded-For (is the reverse proxy setting it?)");
    return new NextResponse("Sign-in is not configured on this server.", { status: 503 });
  }
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const back = (error: string) => redirectTo(req, `${SETUP_PATH}/${encodeURIComponent(token)}?error=${error}`, 303);
  if (!(await take(db, `auth:setup:${sha256(ip)}`, RATE_MAX, RATE_WINDOW_MS))) return back("rate-limited");

  if (form?.get("mode") === "recover") {
    const adminId = await claimRecovery(db, token);
    if (!adminId) return notFound();
    await startHostedSession(adminId);
    const res = redirectTo(req, await landingPath(adminId, "/settings/email"), 303);
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  }
  const jar = await cookies();
  const me = form?.get("mode") === "me" ? await findSession(db, jar.get(SESSION_COOKIE)?.value) : null;
  if (form?.get("mode") === "me" && !me) return back("signed-out");
  const r = await claimSetup(db, { token, email: form?.get("email"), name: form?.get("name"), userId: me?.userId ?? null });
  if (!r.ok) return r.reason === "email-invalid" ? back("email-invalid") : notFound();
  if (!me) await startHostedSession(r.userId);
  const res = redirectTo(req, await landingPath(r.userId, "/settings/email"), 303);
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
