import { db } from "@/lib/db";
import { landingPath, startHostedSession } from "@/lib/auth/login";
import { consumeMagicLink } from "@/lib/auth/magic-link";
import { redirectTo } from "@/lib/http";

/**
 * The link in the email. Opening it signs the person in: the token is consumed once, a new session replaces any old one, and the
 * response redirects at once so the token does not stay in the address bar or reach another site through Referer.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = await consumeMagicLink(db, url.searchParams.get("token"));
  if (!r.ok) return redirectTo(req, "/sign-in?error=link-invalid", 303);
  await startHostedSession(r.userId);
  const res = redirectTo(req, await landingPath(r.userId, url.searchParams.get("next")), 303);
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
