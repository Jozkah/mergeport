import { env } from "@/lib/env";
import { GhAbortedError, GhMissingError, GhTimeoutError, IdentityError, defaultGhRunner, type GhResult, type GhRunner } from "./exec";

/**
 * GitHub access through the official GitHub CLI.
 *
 * - Every call is `gh api ...` with an argument ARRAY and no shell (see exec.ts); nothing is interpolated into a command line.
 * - This file is the transport. WHO a call runs as is decided one layer up (bound.ts): application traffic always runs
 *   with an explicit credential for the profile's own account, never with whatever account `gh` currently has selected.
 *   `ghStatus` below reports the CLI's globally selected account and is used only to start, label and lock a session.
 * - Rate-limit headers, ETags and 304s pass through, so the existing Octokit-based adapter works unchanged on top of
 *   `ghFetch`.
 */

export { GhMissingError, GhTimeoutError, GhAbortedError, IdentityError, defaultGhRunner };
export type { GhResult, GhRunner };

let runner: GhRunner = defaultGhRunner;
export const setGhRunner = (r: GhRunner | null) => {
  runner = r ?? defaultGhRunner;
};
export const getGhRunner = () => runner;

// ---------- identity ----------

export type GhIdentity = { id: bigint; login: string; name: string | null; avatarUrl: string | null; host: string };
export type GhStatus = { state: "ok"; identity: GhIdentity } | { state: "missing-gh" } | { state: "not-logged-in" } | { state: "error"; message: string };

/** Who is signed in to `gh`, by immutable numeric user id. */
export async function ghStatus(run: GhRunner = runner, host = env().MERGEPORT_HOST, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GhStatus> {
  let r: GhResult;
  try {
    r = await run(["api", "--hostname", host, "user"], { timeoutMs: opts.timeoutMs ?? 20_000, signal: opts.signal });
  } catch (e) {
    if (e instanceof GhMissingError) return { state: "missing-gh" };
    if (e instanceof GhTimeoutError || e instanceof GhAbortedError) return { state: "error", message: e.message };
    return { state: "error", message: e instanceof Error ? e.message : "gh failed" };
  }
  if (r.code !== 0) {
    if (/not logged in|gh auth login|authentication|HTTP 401|no oauth token/i.test(r.stderr + r.stdout)) return { state: "not-logged-in" };
    return { state: "error", message: (r.stderr || r.stdout).trim().split("\n")[0].slice(0, 200) || "gh failed" };
  }
  try {
    const u = JSON.parse(r.stdout) as { id: number; login: string; name?: string | null; avatar_url?: string | null };
    return { state: "ok", identity: { id: BigInt(u.id), login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null, host } };
  } catch {
    return { state: "error", message: "Unexpected response from gh api user" };
  }
}

// ---------- fetch over gh ----------

const DROP_HEADERS = new Set(["authorization", "user-agent", "host", "content-length", "accept-encoding", "connection", "content-type"]);

/**
 * A `fetch` implementation backed by `gh api -i`. Any credential header is dropped: gh authenticates itself.
 * Network failures reject with a TypeError (what fetch does), so callers map them to an offline state.
 */
export function ghFetch(run: GhRunner = runner, host = env().MERGEPORT_HOST, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    const method = (init.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
    const path = url.pathname.replace(/^\//, "") + url.search;
    if (path.startsWith("-")) throw new TypeError("Refusing a request path that looks like a command-line option");
    const args = ["api", "--hostname", host, "-i", "-X", method];
    const headers = new Headers(init.headers);
    for (const [k, v] of headers) if (!DROP_HEADERS.has(k.toLowerCase())) args.push("-H", `${k}: ${v}`);
    let body: string | undefined;
    if (init.body !== undefined && init.body !== null) {
      body = typeof init.body === "string" ? init.body : String(init.body);
      args.push("-H", "Content-Type: application/json", "--input", "-");
    }
    args.push(path);
    let r: GhResult;
    try {
      r = await run(args, { input: body, signal: init.signal ?? opts.signal, timeoutMs: opts.timeoutMs });
    } catch (e) {
      if (e instanceof GhMissingError) throw e;
      // The profile's own account cannot be used right now. Say so as an authorization problem and block the request:
      // it is never retried as another account, and it is never reported as "offline".
      if (e instanceof IdentityError) return new Response(JSON.stringify({ message: e.message, mergeport: e.reason }), { status: 401, headers: { "content-type": "application/json", "x-mergeport-identity": e.reason } });
      throw new TypeError("fetch failed"); // timeout, cancellation, spawn failure: indistinguishable from offline for callers
    }
    const parsed = parseHttpResponse(r.stdout);
    if (!parsed) throw new TypeError("fetch failed"); // no HTTP response at all: offline / DNS / gh error
    return new Response(parsed.status === 204 || parsed.status === 304 ? null : parsed.body, { status: parsed.status, headers: parsed.headers });
  }) as typeof fetch;
}

/** Parses the text `gh api -i` prints: status line, headers, blank line, body. */
export function parseHttpResponse(out: string): { status: number; headers: Headers; body: string } | null {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/.exec(out);
  if (!m) return null;
  const rest = out.slice(m[0].length);
  const split = /\r?\n\r?\n/.exec(rest);
  const head = split ? rest.slice(0, split.index) : rest;
  const body = split ? rest.slice(split.index + split[0].length) : "";
  const headers = new Headers();
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { status: Number(m[1]), headers, body };
}

/**
 * Starts `gh auth login` in the browser (device/web flow) and returns what the person must do. The login itself
 * happens inside gh; Mergeport never sees the token. We request ONLY the scopes the product needs and say so.
 */
export const REQUIRED_SCOPES = ["repo", "read:org"] as const;

export function loginCommand(host = env().MERGEPORT_HOST): string {
  return `gh auth login --hostname ${host} --web --git-protocol https --scopes ${REQUIRED_SCOPES.join(",")}`;
}
