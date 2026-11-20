import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { landingPath, startHostedSession } from "@/lib/auth/login";
import { MAGIC_COOKIE, consumeMagicLink } from "@/lib/auth/magic-link";
import { redirectTo } from "@/lib/http";

/**
 * The link in the email. Opening it signs the person in, but only in the browser that asked for it (the cookie set when the link was
 * requested). From any other browser, or from a mail scanner, nothing is consumed and the person is told to use the original browser.
 * On success the token is consumed once, a new session replaces any old one, and the response redirects at once so the token does
 * not stay in the address bar or reach another site through Referer.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const r = await consumeMagicLink(db, url.searchParams.get("token"), jar.get(MAGIC_COOKIE)?.value);
  if (!r.ok) return redirectTo(req, r.reason === "browser" ? "/sign-in?error=link-browser" : "/sign-in?error=link-invalid", 303);
  jar.delete({ name: MAGIC_COOKIE, path: "/auth/magic" });
  await startHostedSession(r.userId);
  const res = redirectTo(req, await landingPath(r.userId, url.searchParams.get("next")), 303);
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
