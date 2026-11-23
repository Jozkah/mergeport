import { cookiesSecure, isPublicHost, publicOrigin } from "@/lib/public-url";

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return "/";
  // Browsers drop tabs and newlines inside a URL, so "/<TAB>/evil.example" would become "//evil.example". Refuse any control character.
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "/";
  }
  return v;
}

/**
 * Redirect on the SAME host the browser used. Next derives `req.url` from its configured hostname ("localhost"), which can
 * differ from the 127.0.0.1 address the browser used; redirecting there would drop the session cookie and trip the
 * form-action policy. The Host header was already checked by proxy.ts to be loopback.
 */
export function redirectTo(req: Request, path: string, status = 307): Response {
  const host = req.headers.get("host") ?? "127.0.0.1";
  // Hosted: the public address (https), never an arbitrary Host header. The Host was already checked by proxy.ts.
  const origin = isPublicHost(host) ? publicOrigin()!.origin : `http://${host}`;
  return new Response(null, { status, headers: { location: `${origin}${path}` } });
}

/** Second line of defence behind proxy.ts: state-changing route handlers re-check the Origin. */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (!host) return false;
  if (origin === "null") return req.headers.get("sec-fetch-site") === "same-origin"; // see proxy.ts
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

export const secureCookies = () => cookiesSecure(); // loopback http: plain; a hosted https address: Secure
