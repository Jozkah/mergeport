import { cookies } from "next/headers";
import { clientIp } from "@/lib/auth/hosted-config";
import { db } from "@/lib/db";
import { githubAppConfig } from "@/lib/github/app-config";
import { SIGNIN_COOKIE, SIGNIN_COOKIE_PATH, githubSignInEnabled, signinRedirectUri, startSignIn } from "@/lib/github/sign-in";
import { redirectTo } from "@/lib/http";
import { cookiesSecure, publicOrigin } from "@/lib/public-url";

/**
 * Where the "Continue with GitHub" button on the sign-in page goes (a plain link, like the OpenID Connect start). It stores a
 * single-use state, puts the browser nonce in an HttpOnly cookie (also the PKCE verifier, sent only to the callback) and sends the
 * browser to GitHub. It does nothing a stranger could not already do by visiting the sign-in page, so a GET is fine; it is rate
 * limited per client address. Not hosted, or the App not configured: the route does not exist.
 */
export async function GET(req: Request) {
  const origin = publicOrigin();
  const config = githubAppConfig();
  if (!origin || !config || !githubSignInEnabled()) return new Response("Not found", { status: 404 });
  // Like the other sign-in routes: the per-client limit needs an address, and without one it is refused rather than run unlimited.
  const ip = clientIp(req);
  if (!ip) {
    console.error("[auth] sign-in refused: no client address in X-Forwarded-For (is the reverse proxy setting it?)");
    return new Response("Sign-in is not configured on this server.", { status: 503 });
  }
  try {
    const started = await startSignIn(db, { config, redirectUri: signinRedirectUri(origin.origin), ip, next: new URL(req.url).searchParams.get("next") });
    if (started === "rate-limited") return redirectTo(req, "/sign-in?error=github-rate-limited", 303);
    (await cookies()).set(SIGNIN_COOKIE, started.nonce, { httpOnly: true, sameSite: "lax", secure: cookiesSecure(), path: SIGNIN_COOKIE_PATH, maxAge: started.maxAgeSeconds });
    const res = new Response(null, { status: 302, headers: { location: started.url } });
    res.headers.set("cache-control", "no-store");
    return res;
  } catch {
    console.error("[auth] could not start sign-in with GitHub");
    return redirectTo(req, "/sign-in?error=github-error", 303);
  }
}
