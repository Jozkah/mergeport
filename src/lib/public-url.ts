/**
 * Hosted deployments set MERGEPORT_PUBLIC_URL (for example https://app.example.com). Without it Mergeport is the local app: it
 * answers only on loopback names. Read from process.env on every call (not the cached env()) because proxy.ts and the tests
 * both need the current value.
 */
export function publicOrigin(): URL | null {
  const raw = process.env.MERGEPORT_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return new URL(u.origin);
  } catch {
    return null;
  }
}

export const isHosted = () => publicOrigin() !== null;

/** Session and sign-in cookies are Secure whenever the public address is https. Loopback http keeps them plain. */
export const cookiesSecure = () => publicOrigin()?.protocol === "https:";

/** True when the Host header names the configured public address. */
export function isPublicHost(host: string | null | undefined): boolean {
  const p = publicOrigin();
  return Boolean(p && host && host === p.host);
}

/** Routes that belong to the local app (gh sign-in, launcher links, demo, hub connect) do not exist on a hosted deployment. */
export function refuseWhenHosted(): Response | null {
  return isHosted() ? new Response("Not found", { status: 404 }) : null;
}

/** The origin links and redirects should use for a request: the public one when hosted, otherwise the host the browser used. */
export function originFor(req: Request): string {
  const p = publicOrigin();
  if (p) return p.origin;
  return `http://${req.headers.get("host") ?? "127.0.0.1"}`;
}
