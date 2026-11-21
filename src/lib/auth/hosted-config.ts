import { githubAppConfigProblems } from "@/lib/github/app-config";
import { isHosted } from "@/lib/public-url";

/**
 * Per-client limits are only as good as the client address. Behind a reverse proxy the socket address is the proxy's, so the address
 * has to come from X-Forwarded-For, and only from the entries a proxy WE operate appended: each trusted proxy adds the address it saw
 * on the right, so with N trusted proxies the client is the Nth entry from the RIGHT. The left-hand entries are whatever the client
 * claimed and are never used. A hosted deployment refuses to start (and its sign-in refuses requests) without this being declared.
 */
export function trustedProxyHops(): number {
  const n = Number.parseInt(process.env.MERGEPORT_TRUSTED_PROXY_HOPS ?? "1", 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

export function hostedConfigProblems(): string[] {
  if (!isHosted()) return [];
  const problems: string[] = [];
  if (process.env.MERGEPORT_TRUST_PROXY !== "true") {
    problems.push("MERGEPORT_TRUST_PROXY=true is required on a hosted deployment: without a trusted X-Forwarded-For source there is no client address to rate-limit sign-in on. Run behind a reverse proxy you control that appends the client address, then set it.");
  }
  const hops = process.env.MERGEPORT_TRUSTED_PROXY_HOPS;
  if (hops !== undefined && hops !== "" && !/^(?:[1-9]|10)$/.test(hops)) problems.push("MERGEPORT_TRUSTED_PROXY_HOPS must be a whole number from 1 to 10.");
  if ((process.env.MERGEPORT_GITHUB_API_BASE ?? "").trim() !== "") problems.push("MERGEPORT_GITHUB_API_BASE is for tests and local development only and is refused on a hosted deployment: unset it.");
  problems.push(...githubAppConfigProblems());
  return problems;
}

/** Throws with every problem listed. Called at server start and again on the first sign-in request. */
export function assertHostedConfig(): void {
  const p = hostedConfigProblems();
  if (p.length) throw new Error(`Hosted configuration is incomplete:\n- ${p.join("\n- ")}`);
}

/** The client address as the trusted proxy chain reports it, or null when it cannot be determined (not trusted, header missing or too short). */
export function clientIp(req: Request): string | null {
  return clientIpFromHeaders(req.headers);
}

/** Same, from a bare header set (server actions read `headers()`). */
export function clientIpFromHeaders(h: { get(name: string): string | null }): string | null {
  if (process.env.MERGEPORT_TRUST_PROXY !== "true") return null;
  const entries = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const i = entries.length - trustedProxyHops();
  return i >= 0 ? entries[i] : null;
}
