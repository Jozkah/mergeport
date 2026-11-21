import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { githubAppConfig, type EnvLike, type GithubAppConfig } from "./app-config";
import { isBoundInstallation, type BoundInstallation } from "./bound-installation";

/**
 * GitHub App authentication: the app JWT and installation access tokens.
 *
 * - The app private key is read from the environment, used to sign a short JWT and never stored or logged.
 * - Installation tokens live only in this process's memory (cache below). They are never written to the database, a log or an error message.
 * - Every error carries a fixed message plus a status number; response bodies are never copied into it.
 */

export const GITHUB_API_BASE = "https://api.github.com";

/**
 * The API base. `MERGEPORT_GITHUB_API_BASE` (tests, a local fake) is honoured ONLY when NODE_ENV is `test` or `development`, so a
 * production deployment (or one with NODE_ENV unset) can never be pointed at another host by its environment. It must be https, or
 * http on a loopback name. A hosted deployment refuses to start with it set (hosted-config).
 */
export function githubApiBase(env: EnvLike = process.env): string {
  const o = (env.MERGEPORT_GITHUB_API_BASE ?? "").trim();
  if (o && (env.NODE_ENV === "test" || env.NODE_ENV === "development")) {
    try {
      const u = new URL(o);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return o.replace(/\/+$/, "");
    } catch {
      // fall through to the constant
    }
  }
  return GITHUB_API_BASE;
}

// ---------- errors ----------

export type GithubAppErrorCode = "installation_gone" | "installation_suspended" | "rate_limited" | "app_misconfigured" | "unavailable";

export class GithubAppError extends Error {
  constructor(readonly code: GithubAppErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = new.target.name;
  }
}
/** 404: the installation was uninstalled or never existed. */
export class InstallationGoneError extends GithubAppError {
  constructor(status = 404) {
    super("installation_gone", "The GitHub App is no longer installed for this account.", status);
  }
}
/** 403: the account owner suspended the installation. */
export class InstallationSuspendedError extends GithubAppError {
  constructor(status = 403) {
    super("installation_suspended", "The GitHub App installation is suspended.", status);
  }
}
export class RateLimitedError extends GithubAppError {
  constructor(readonly retryAfterMs: number | null = null, status = 403) {
    super("rate_limited", "GitHub rate limit reached for the GitHub App.", status);
  }
}
/** The App itself is unusable: no or invalid configuration, or GitHub rejected the app JWT. */
export class AppMisconfiguredError extends GithubAppError {
  constructor(message = "The GitHub App is not configured correctly.", status?: number) {
    super("app_misconfigured", message, status);
  }
}

// ---------- app JWT ----------

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Seconds the `iat` is set in the past to absorb clock skew, and the lifetime after `iat` (GitHub allows 10 minutes after "now"). */
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 9 * 60;

let keyMemo: { pem: string; key: KeyObject } | null = null;
function privateKey(config: GithubAppConfig): KeyObject {
  if (keyMemo?.pem === config.privateKeyPem) return keyMemo.key;
  const key = createPrivateKey(config.privateKeyPem);
  keyMemo = { pem: config.privateKeyPem, key };
  return key;
}

/** RS256 JWT: iat = now - 60 s, exp = iat + 9 min, iss = App id. */
export function signAppJwt(config: Pick<GithubAppConfig, "appId" | "privateKeyPem">, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_SECONDS;
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: config.appId }));
  const data = `${head}.${body}`;
  let sig: Buffer;
  try {
    sig = sign("RSA-SHA256", Buffer.from(data), privateKey(config as GithubAppConfig));
  } catch {
    throw new AppMisconfiguredError("The GitHub App private key could not be used to sign.");
  }
  return `${data}.${b64u(sig)}`;
}

// ---------- installation tokens ----------

export type InstallationToken = { token: string; /** epoch ms */ expiresAt: number };

/**
 * What the rest of the app depends on, so tests inject a fake instead of GitHub. It takes a BoundInstallation (a binding the workspace
 * proved), never a bare id.
 */
export interface InstallationTokenProvider {
  getToken(installation: BoundInstallation): Promise<InstallationToken>;
}

export type MintOptions = {
  /** Defaults to the validated environment configuration. */
  config?: GithubAppConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
  env?: EnvLike;
  /** Overrides the API base (tests); the environment override is separately restricted to test and development. */
  apiBase?: string;
  /** Deadline for the whole request including the body (default 10 s). */
  timeoutMs?: number;
};

/** Refresh when less than this remains. */
export const REFRESH_WITHIN_MS = 10 * 60_000;
/** How long "gone" and "suspended" answers are remembered. */
export const NEGATIVE_TTL_MS = 60_000;
/** Hard cap on each cache (oldest entries are evicted first) and on the response body we are willing to read. */
export const CACHE_MAX_ENTRIES = 5000;
export const MAX_BODY_BYTES = 1_000_000;
export const REQUEST_TIMEOUT_MS = 10_000;

type Neg = { until: number; make: () => GithubAppError };
const tokens = new Map<string, InstallationToken>();
const inflight = new Map<string, Promise<InstallationToken>>();
const negatives = new Map<string, Neg>();

/** Test hook: forget every cached token, in-flight request and negative answer. */
export function resetInstallationTokenCache(): void {
  tokens.clear();
  inflight.clear();
  negatives.clear();
}

/** Test hook: how many entries each cache holds. */
export const installationTokenCacheSizes = () => ({ tokens: tokens.size, negatives: negatives.size, inflight: inflight.size });

/** Insert with a sweep of expired entries and a hard cap (oldest first). Re-inserting moves an entry to the newest position. */
function remember<V>(map: Map<string, V>, key: string, value: V, expired: (v: V) => boolean): void {
  for (const [k, v] of map) if (expired(v)) map.delete(k);
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

/**
 * A usable installation access token (cached, refreshed 10 minutes before expiry, one request shared by concurrent callers).
 * Only a BoundInstallation is accepted: one the workspace proved it controls, loaded by `loadBoundInstallation`. A forged object
 * is refused at run time as well as by the type.
 */
export async function mintInstallationToken(installation: BoundInstallation, opts: MintOptions = {}): Promise<InstallationToken> {
  if (!isBoundInstallation(installation)) throw new AppMisconfiguredError("An installation token needs a verified workspace binding.");
  const id = String(installation.installationId);
  const now = (opts.now ?? Date.now)();

  const neg = negatives.get(id);
  if (neg) {
    if (neg.until > now) throw neg.make();
    negatives.delete(id);
  }
  const hit = tokens.get(id);
  if (hit && hit.expiresAt - now >= REFRESH_WITHIN_MS) return hit;

  const running = inflight.get(id);
  if (running) return running;

  const p = (async () => {
    try {
      const fresh = await requestToken(id, opts, now);
      remember(tokens, id, fresh, (v) => v.expiresAt <= now);
      return fresh;
    } catch (e) {
      if (e instanceof InstallationGoneError) remember(negatives, id, { until: now + NEGATIVE_TTL_MS, make: () => new InstallationGoneError(e.status) }, (v) => v.until <= now);
      else if (e instanceof InstallationSuspendedError) remember(negatives, id, { until: now + NEGATIVE_TTL_MS, make: () => new InstallationSuspendedError(e.status) }, (v) => v.until <= now);
      if (e instanceof InstallationGoneError || e instanceof InstallationSuspendedError) tokens.delete(id);
      // A still-valid token beats an error from a transient failure of the refresh.
      if (hit && hit.expiresAt - now > 60_000 && e instanceof GithubAppError && (e.code === "unavailable" || e.code === "rate_limited")) return hit;
      throw e;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

/** Reads at most MAX_BODY_BYTES; larger is an error. Streams when it can so an endless body is cut off early. */
export async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new GithubAppError("unavailable", "GitHub returned an oversize response.", res.status);
  if (!res.body) {
    const t = await res.text();
    if (t.length > MAX_BODY_BYTES) throw new GithubAppError("unavailable", "GitHub returned an oversize response.", res.status);
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new GithubAppError("unavailable", "GitHub returned an oversize response.", res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const unavailable = (m: string, status?: number) => new GithubAppError("unavailable", m, status);

async function requestToken(id: string, opts: MintOptions, now: number): Promise<InstallationToken> {
  const config = opts.config === undefined ? githubAppConfig(opts.env) : opts.config;
  if (!config) throw new AppMisconfiguredError("The GitHub App is not configured.");
  const jwt = signAppJwt(config, now);
  const base = (opts.apiBase ?? githubApiBase(opts.env ?? process.env)).replace(/\/+$/, "");

  // One deadline covers connecting, headers and the body. The abort signal is passed on, and the race below also settles when a
  // fetch ignores the signal, so a hung request can never stall the callers waiting on the shared in-flight promise.
  const ms = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(unavailable("GitHub did not answer in time."));
    }, ms);
  });
  const work = (async (): Promise<{ status: number; headers: Headers; text: string }> => {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(`${base}/app/installations/${id}/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" },
        redirect: "error",
        signal: ac.signal,
      });
    } catch {
      throw unavailable("GitHub could not be reached.");
    }
    try {
      return { status: res.status, headers: res.headers, text: await readCapped(res) };
    } catch (e) {
      if (e instanceof GithubAppError) throw e;
      throw unavailable("GitHub returned an unreadable response.", res.status);
    }
  })();
  work.catch(() => {}); // when the deadline wins, a late failure of `work` is not an unhandled rejection
  let out: { status: number; headers: Headers; text: string };
  try {
    out = await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }

  const parse = (): { token?: unknown; expires_at?: unknown; message?: unknown } | null => {
    try {
      const j = JSON.parse(out.text);
      return j && typeof j === "object" ? j : null;
    } catch {
      return null;
    }
  };
  if (out.status === 201 || out.status === 200) {
    const b = parse();
    if (!b) throw unavailable("GitHub returned an unreadable token response.", out.status);
    const expiresAt = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
    if (typeof b.token !== "string" || !b.token || !Number.isFinite(expiresAt)) throw unavailable("GitHub returned an invalid token response.", out.status);
    return { token: b.token, expiresAt };
  }
  const bm = parse()?.message;
  const message = typeof bm === "string" ? bm : "";
  if (out.status === 404) throw new InstallationGoneError();
  if (out.status === 401) throw new AppMisconfiguredError("GitHub rejected the GitHub App credentials.", 401);
  if (out.status === 429 || (out.status === 403 && (out.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) {
    const ra = Number(out.headers.get("retry-after"));
    const reset = Number(out.headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : null;
    throw new RateLimitedError(wait, out.status);
  }
  if (out.status === 403) {
    if (/suspend/i.test(message)) throw new InstallationSuspendedError();
    throw new AppMisconfiguredError("GitHub refused the GitHub App request.", 403);
  }
  throw unavailable(`GitHub answered ${out.status} to the token request.`, out.status);
}

/** A provider over `mintInstallationToken`, for dependency injection. */
export function createInstallationTokenProvider(opts: MintOptions = {}): InstallationTokenProvider {
  return { getToken: (installation) => mintInstallationToken(installation, opts) };
}
