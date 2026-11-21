import { cookies } from "next/headers";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { githubAppConfig } from "@/lib/github/app-config";
import { LINK_COOKIE, LINK_COOKIE_PATH, completeLink, linkRedirectUri } from "@/lib/github/user-link";
import { redirectTo } from "@/lib/http";
import { isHosted, publicOrigin } from "@/lib/public-url";

/**
 * Where GitHub sends the browser after the person authorizes the Mergeport GitHub App for their own account. A GET that changes
 * something, so everything it does is behind the state claim in `completeLink`: a session of the SAME person who started it, a
 * single-use unexpired state, this browser's nonce cookie (also the PKCE verifier), and the account GitHub itself reports for the
 * token. The query is never trusted and never echoed: the answer is a redirect to Settings with one fixed result code, with
 * `Referrer-Policy: no-referrer`, and the redirect target is always a path on this site.
 */
export async function GET(req: Request) {
  const origin = publicOrigin();
  const config = githubAppConfig();
  if (!isHosted() || !origin || !config) return new Response("Not found", { status: 404 });

  const done = (path: string) => {
    const res = redirectTo(req, path, 303);
    res.headers.set("referrer-policy", "no-referrer");
    res.headers.set("cache-control", "no-store");
    return res;
  };

  const jar = await cookies();
  const session = await findSession(db, jar.get(SESSION_COOKIE)?.value);
  // Not signed in: nothing is consumed (the code in the address stays unused and expires). Sign in, then start again from Settings.
  if (!session) return done(`/sign-in?next=${encodeURIComponent("/settings")}`);

  const q = new URL(req.url).searchParams;
  const param = (k: string) => {
    const v = q.get(k);
    return v !== null && v.length <= 300 ? v : null;
  };
  const result = await completeLink(db, {
    userId: session.userId,
    state: param("state"),
    code: param("code"),
    nonce: jar.get(LINK_COOKIE)?.value ?? null,
    config,
    redirectUri: linkRedirectUri(origin.origin),
    // The nonce cookie is dropped only once a real state was claimed: a forged or malformed GET (SameSite=Lax sends the session)
    // must not break someone's flow in progress.
    onClaimed: () => jar.delete({ name: LINK_COOKIE, path: LINK_COOKIE_PATH }),
  });
  return done(`/settings?githublink=${result}#github-account`);
}
