import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { githubAppConfig, type EnvLike, type GithubAppConfig } from "./app-config";

/**
 * GitHub App authentication: the app JWT and installation access tokens.
 *
 * - The app private key is read from the environment, used to sign a short JWT and never stored or logged.
 * - Installation tokens live only in this process's memory (cache below). They are never written to the database, a log or an error message.
 * - Every error carries a fixed message plus a status number; response bodies are never copied into it.
 */

export const GITHUB_API_BASE = "https://api.github.com";

/**
 * The API base. `MERGEPORT_GITHUB_API_BASE` (tests, a local fake) is honoured ONLY outside production, so a production deployment can
 * never be pointed at another host by its environment.
 */
export function githubApiBase(env: EnvLike = process.env): string {
  const o = (env.MERGEPORT_GITHUB_API_BASE ?? "").trim();
  if (o && env.NODE_ENV !== "production") {
    try {
      const u = new URL(o);
      if (u.protocol === "https:" || u.protocol === "http:") return o.replace(/\/+$/, "");
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

/** What the rest of the app depends on, so tests inject a fake instead of GitHub. */
export interface InstallationTokenProvider {
  getToken(installationId: bigint | number | string): Promise<InstallationToken>;
}

export type MintOptions = {
  /** Defaults to the validated environment configuration. */
  config?: GithubAppConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
  env?: EnvLike;
  /** Overrides the API base (tests); the environment override is separately restricted to non-production. */
  apiBase?: string;
};

/** Refresh when less than this remains. */
export const REFRESH_WITHIN_MS = 10 * 60_000;
/** How long "gone" and "suspended" answers are remembered. */
export const NEGATIVE_TTL_MS = 60_000;

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

const idString = (id: bigint | number | string): string => {
  const s = String(id);
  if (!/^[1-9]\d{0,18}$/.test(s)) throw new AppMisconfiguredError("Invalid installation id.");
  return s;
};

/** A usable installation access token (cached, refreshed 10 minutes before expiry, one request shared by concurrent callers). */
export async function mintInstallationToken(installationId: bigint | number | string, opts: MintOptions = {}): Promise<InstallationToken> {
  const id = idString(installationId);
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
      tokens.set(id, fresh);
      return fresh;
    } catch (e) {
      if (e instanceof InstallationGoneError) negatives.set(id, { until: now + NEGATIVE_TTL_MS, make: () => new InstallationGoneError(e.status) });
      else if (e instanceof InstallationSuspendedError) negatives.set(id, { until: now + NEGATIVE_TTL_MS, make: () => new InstallationSuspendedError(e.status) });
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

async function requestToken(id: string, opts: MintOptions, now: number): Promise<InstallationToken> {
  const config = opts.config === undefined ? githubAppConfig(opts.env ?? process.env) : opts.config;
  if (!config) throw new AppMisconfiguredError("The GitHub App is not configured.");
  const jwt = signAppJwt(config, now);
  const base = (opts.apiBase ?? githubApiBase(opts.env ?? process.env)).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${base}/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" },
      redirect: "error",
    });
  } catch {
    throw new GithubAppError("unavailable", "GitHub could not be reached.");
  }
  if (res.status === 201 || res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new GithubAppError("unavailable", "GitHub returned an unreadable token response.", res.status);
    }
    const b = body as { token?: unknown; expires_at?: unknown };
    const expiresAt = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
    if (typeof b.token !== "string" || !b.token || !Number.isFinite(expiresAt)) throw new GithubAppError("unavailable", "GitHub returned an invalid token response.", res.status);
    return { token: b.token, expiresAt };
  }
  const message = await res.json().then((j: { message?: unknown }) => (typeof j?.message === "string" ? j.message : ""), () => "");
  if (res.status === 404) throw new InstallationGoneError();
  if (res.status === 401) throw new AppMisconfiguredError("GitHub rejected the GitHub App credentials.", 401);
  if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) {
    const ra = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : null;
    throw new RateLimitedError(wait, res.status);
  }
  if (res.status === 403) {
    if (/suspend/i.test(message)) throw new InstallationSuspendedError();
    throw new AppMisconfiguredError("GitHub refused the GitHub App request.", 403);
  }
  throw new GithubAppError("unavailable", `GitHub answered ${res.status} to the token request.`, res.status);
}

/** A provider over `mintInstallationToken`, for dependency injection. */
export function createInstallationTokenProvider(opts: MintOptions = {}): InstallationTokenProvider {
  return { getToken: (id) => mintInstallationToken(id, opts) };
}
