import { cookies } from "next/headers";
import { clientIp } from "@/lib/auth/hosted-config";
import { landingPath, startHostedSession } from "@/lib/auth/login";
import { db } from "@/lib/db";
import { githubAppConfig } from "@/lib/github/app-config";
import { SIGNIN_COOKIE, SIGNIN_COOKIE_PATH, completeSignIn, githubSignInEnabled, signinRedirectUri } from "@/lib/github/sign-in";
import { redirectTo } from "@/lib/http";
import { publicOrigin } from "@/lib/public-url";

/**
 * Where GitHub sends the browser after the person authorizes the Mergeport GitHub App to sign them in. A plain browser GET (so
 * `proxy.ts` has nothing to add: its Origin rule is for state-changing methods and stays as it is). Everything it does is behind the
 * state claim in `completeSignIn`: a single-use unexpired state, this browser's nonce cookie (also the PKCE verifier), and the account
 * GitHub itself reports for the token. The query is never trusted and never echoed: the answer is a redirect with one fixed code, with
 * `Referrer-Policy: no-referrer`, and the target is always a path on this site. A session cookie the browser arrived with is ignored
 * and replaced on success (session fixation), and never consulted: sign-in does not need one.
 */
export async function GET(req: Request) {
  const origin = publicOrigin();
  const config = githubAppConfig();
  if (!origin || !config || !githubSignInEnabled()) return new Response("Not found", { status: 404 });
  const done = (path: string) => {
    const res = redirectTo(req, path, 303);
    res.headers.set("referrer-policy", "no-referrer");
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const ip = clientIp(req);
  if (!ip) {
    console.error("[auth] sign-in refused: no client address in X-Forwarded-For (is the reverse proxy setting it?)");
    return new Response("Sign-in is not configured on this server.", { status: 503 });
  }
  const jar = await cookies();
  const q = new URL(req.url).searchParams;
  const param = (k: string) => {
    const v = q.get(k);
    return v !== null && v.length <= 300 ? v : null;
  };
  const r = await completeSignIn(db, {
    state: param("state"),
    code: param("code"),
    nonce: jar.get(SIGNIN_COOKIE)?.value ?? null,
    ip,
    config,
    redirectUri: signinRedirectUri(origin.origin),
    // Dropped only once a real state was claimed: a forged or malformed GET must not break a sign-in in progress.
    onClaimed: () => jar.delete({ name: SIGNIN_COOKIE, path: SIGNIN_COOKIE_PATH }),
  });
  if (!r.ok) return done(`/sign-in?error=github-${r.reason}`);
  await startHostedSession(r.userId);
  return done(await landingPath(r.userId, r.next));
}
