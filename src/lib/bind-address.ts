import { publicOrigin } from "@/lib/public-url";

/**
 * Where `npm start` listens (scripts/start.ts). HOST defaults to loopback so the local app is unchanged; a hosted deployment inside a
 * container or behind a proxy on another machine sets HOST=0.0.0.0. MERGEPORT_PORT, then PORT, default to 3000.
 *
 * The guard that matters: proxy.ts decides "local app" by the Host HEADER, which any remote caller can set to 127.0.0.1. So a
 * non-loopback bind is only allowed when MERGEPORT_PUBLIC_URL is set (hosted mode: public host only, loopback and demo routes refused).
 * Without it the server would be reachable from the network under the local app's loopback exemptions.
 */
const HOST_OK = /^[A-Za-z0-9._:\-[\]]+$/;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export function resolveBind(env: Record<string, string | undefined> = process.env): { host: string; port: number } {
  const host = (env.MERGEPORT_HOST ?? "").trim() || (env.HOST ?? "").trim() || "127.0.0.1";
  if (!HOST_OK.test(host)) throw new Error(`HOST "${host}" is not a valid address or name.`);
  const rawPort = (env.MERGEPORT_PORT ?? "").trim() || (env.PORT ?? "").trim() || "3000";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT "${rawPort}" is not a port number from 1 to 65535.`);
  if (!isLoopbackHost(host) && !publicOrigin(env.MERGEPORT_PUBLIC_URL)) {
    throw new Error(
      `Refusing to listen on ${host}: that is reachable from the network, and without MERGEPORT_PUBLIC_URL Mergeport is the local app (it trusts requests that claim a loopback Host). ` +
        "Set MERGEPORT_PUBLIC_URL (hosted mode, with MERGEPORT_TRUST_PROXY=true behind your reverse proxy), or leave HOST unset to stay on 127.0.0.1.",
    );
  }
  return { host, port };
}
