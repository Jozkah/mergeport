import { cookies } from "next/headers";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { githubAppConfig } from "@/lib/github/app-config";
import { CALLBACK_PATH, CONNECT_COOKIE, CONNECT_COOKIE_PATH, completeConnect } from "@/lib/github/connect";
import { redirectTo } from "@/lib/http";
import { isHosted, publicOrigin } from "@/lib/public-url";

/**
 * Where GitHub sends the browser after the install page or the OAuth authorize page. A GET that changes something, so everything it
 * does is behind the state claim in `completeConnect`: a session of the SAME person who started it, a single-use unexpired state,
 * this browser's nonce cookie, a role that may connect GitHub, and a user token that shows the installation to that person and
 * proves they control it. The query is never trusted and never echoed: the answer is a redirect to Settings with one fixed result code.
 * The response carries `Referrer-Policy: no-referrer` and the redirect target holds no secrets.
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
  if (!session) return done(`/sign-in?next=${encodeURIComponent("/settings/github")}`);

  const nonce = jar.get(CONNECT_COOKIE)?.value ?? null;
  jar.delete({ name: CONNECT_COOKIE, path: CONNECT_COOKIE_PATH }); // one use, whatever happens next

  const q = new URL(req.url).searchParams;
  const param = (k: string) => {
    const v = q.get(k);
    return v !== null && v.length <= 300 ? v : null;
  };
  const result = await completeConnect(db, {
    userId: session.userId,
    state: param("state"),
    code: param("code"),
    installationId: param("installation_id"),
    setupAction: param("setup_action"),
    nonce,
    config,
    redirectUri: `${origin.origin}${CALLBACK_PATH}`,
  });
  return done(`/settings/github?github=${result}`);
}
