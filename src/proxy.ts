import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/lib/csp";
import { isHosted, isPublicHost } from "@/lib/public-url";

/**
 * Local-only guard, run before every request.
 *
 * Mergeport is a LOCAL application bound to 127.0.0.1. Other web pages in your browser (and other processes) can still
 * send requests to that address, so we refuse:
 *  - any Host that is not the loopback name we serve (blocks DNS rebinding);
 *  - state-changing requests whose Origin / Sec-Fetch-Site is not this same origin (blocks cross-site forms and fetches).
 * Pages additionally require the session cookie.
 */
const FEDERATION_S2S = new Set(["/api/federation/v1/token", "/api/federation/v1/revoke"]);
/** GitHub's webhook delivery (docs/github-app.md): a server-to-server POST signed with the App's webhook secret, no cookie, no Origin. Exactly this path and method. */
const GITHUB_WEBHOOK = "/api/github/webhook";
/** The hosted MCP endpoint (docs/mcp.md): a POST from an AI app, authorised only by a personal access token in `Authorization: Bearer`. */
const MCP_ENDPOINT = "/api/mcp";
const OAUTH_MACHINE = new Set(["/api/oauth/register", "/api/oauth/token"]);
const LOOPBACK =/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * Pages hold personal data but live only in this browser: `private, no-cache` lets the browser keep them (back/forward
 * restores instantly) while always revalidating. API responses (session, event stream, actions) are never stored. The app
 * icon is public and static.
 */
export function cacheControlFor(pathname: string): string {
  if (pathname === "/icon.svg") return "public, max-age=86400, stale-while-revalidate=604800";
  if (pathname.startsWith("/api/")) return "no-store";
  return "private, no-cache";
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  // Local app: loopback names only. Hosted (MERGEPORT_PUBLIC_URL): ONLY the public host. A reverse proxy can forward a client's own
  // "Host: 127.0.0.1" header, so loopback names are no proof of a local caller there.
  if (isHosted()) {
    if (!isPublicHost(host)) return new NextResponse("Forbidden host", { status: 403 });
    // The local app's routes do not exist here, except sign-out.
    const p = req.nextUrl.pathname;
    if (p.startsWith("/api/local/") && p !== "/api/local/signout") return new NextResponse("Not found", { status: 404 });
  } else if (!LOOPBACK.test(host)) return new NextResponse("Forbidden host", { status: 403 });

  const method = req.method.toUpperCase();
  // Federation's server-to-server POSTs (another instance, no browser, no cookies) carry no Origin and no Sec-Fetch-Site. They are
  // authorised by a PKCE code or a bearer token, never by a cookie, so the cross-site rule has nothing to protect there.
  // The GitHub webhook is the same kind of caller: it is authorised only by the HMAC of its body, checked in the route before anything else.
  // The MCP endpoint is exempt only for a request that is plainly not a browser's: a Bearer header, and none of Origin, Sec-Fetch-Site
  // (every browser sets one of them on a cross-site request) or Cookie. The route ignores cookies and answers no CORS preflight.
  const mcpClient =
    method === "POST" &&
    req.nextUrl.pathname === MCP_ENDPOINT &&
    /^Bearer\s/i.test(req.headers.get("authorization") ?? "") &&
    !req.headers.has("origin") &&
    !req.headers.has("sec-fetch-site") &&
    !req.headers.has("cookie");
  // The OAuth machine endpoints (client registration and the token endpoint, docs/mcp.md) are called by the AI app's server, not by a
  // browser: same rule without the Bearer header (their credentials are in the body). The consent page and its action are NOT exempt.
  const oauthMachine = method === "POST" && OAUTH_MACHINE.has(req.nextUrl.pathname) && !req.headers.has("origin") && !req.headers.has("sec-fetch-site") && !req.headers.has("cookie");
  const serverToServer = isHosted() && (FEDERATION_S2S.has(req.nextUrl.pathname) || (method === "POST" && req.nextUrl.pathname === GITHUB_WEBHOOK) || mcpClient || oauthMachine);
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !serverToServer) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    let ok = false;
    if (origin === "null") {
      // A form posted from a page with Referrer-Policy: no-referrer, or from a sandboxed frame, carries "Origin: null". Only the browser-set
      // Sec-Fetch-Site (page script cannot forge it) can tell a same-origin post from a cross-site one.
      ok = site === "same-origin";
    } else if (origin) {
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
    } else ok = site === "same-origin" || site === "none";
    if (!ok) return new NextResponse("Cross-origin request refused", { status: 403 });
  }
  // The CSP carries a per-request script nonce. Next reads it from the REQUEST header to stamp its inline scripts, and the browser enforces the response header.
  const csp = buildCsp(newNonce(), process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Frame-Options", "DENY"); // same rule as CSP frame-ancestors 'none' for browsers that only know the old header: the approval page must not be framed
  res.headers.set("Cache-Control", cacheControlFor(req.nextUrl.pathname));
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
