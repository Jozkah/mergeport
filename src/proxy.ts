import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/lib/csp";

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
  if (!LOOPBACK.test(host)) return new NextResponse("Forbidden host", { status: 403 });

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    let ok = false;
    if (origin) {
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
