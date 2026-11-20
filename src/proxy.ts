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
 * Pages additionally require the session cookie that only the launcher-opened browser receives.
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

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
  // "Host: 127.0.0.1" header, so loopback names are no proof of a local caller there; only the launcher's readiness probe keeps them.
  if (isHosted()) {
    const probe = req.nextUrl.pathname === "/api/local/ready" && LOOPBACK.test(host);
    if (!isPublicHost(host) && !probe) return new NextResponse("Forbidden host", { status: 403 });
    // The local app's routes do not exist here, except sign-out and the launcher's own readiness probe (loopback only, checked above).
    const p = req.nextUrl.pathname;
    if (p.startsWith("/api/local/") && p !== "/api/local/signout" && !(p === "/api/local/ready" && probe)) return new NextResponse("Not found", { status: 404 });
  } else if (!LOOPBACK.test(host)) return new NextResponse("Forbidden host", { status: 403 });

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
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
  res.headers.set("Cache-Control", cacheControlFor(req.nextUrl.pathname));
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
