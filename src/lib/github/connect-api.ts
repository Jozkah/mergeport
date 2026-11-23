import { createHash } from "node:crypto";
import { GithubAppError, githubApiBase, readCapped, signAppJwt } from "./app-auth";
import type { GithubAppConfig } from "./app-config";
import type { InstallationFacts } from "./binding";

/**
 * The few GitHub calls the connect flow makes (docs/github-app.md, "Connect flow"):
 *  - the OAuth code exchange (github.com), with the App's client id and secret;
 *  - three calls AS THE USER, with the short-lived user-to-server token: GET /user, GET /user/installations, GET /user/memberships/orgs/:org;
 *  - one call AS THE APP, with the app JWT: GET /app/installations/:id.
 *
 * The user token lives in one function call: it is never stored, never logged, never put in an error message and never returned to a
 * page. Errors here carry fixed text; GitHub's response text is not copied. Every request has a deadline, no redirects and a body cap.
 */

export const GITHUB_WEB_BASE = "https://github.com";

/**
 * The github.com (web) base: authorize, install and OAuth token pages. `MERGEPORT_GITHUB_WEB_BASE` (the local fake GitHub, docs/dev-github-fake.md)
 * is honoured ONLY when NODE_ENV is `test` or `development` and ONLY for http(s) on a loopback name, so a production deployment (or one with
 * NODE_ENV unset) can never send people or secrets to another host. A hosted deployment refuses to start with it set unless NODE_ENV is
 * `development` (hosted-config).
 */
export function githubWebBase(env: Record<string, string | undefined> = process.env): string {
  const o = (env.MERGEPORT_GITHUB_WEB_BASE ?? "").trim();
  if (o && (env.NODE_ENV === "test" || env.NODE_ENV === "development")) {
    try {
      const u = new URL(o);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if ((u.protocol === "http:" || u.protocol === "https:") && loopback && !u.username && !u.password) return o.replace(/\/+$/, "");
    } catch {
      // fall through to the constant
    }
  }
  return GITHUB_WEB_BASE;
}
export const CONNECT_TIMEOUT_MS = 10_000;
/** `GET /user/installations` is read this many pages at most (100 per page): a person with more installations than this is not served. */
export const MAX_INSTALLATION_PAGES = 20;

export type ConnectDeps = {
  fetch?: typeof fetch;
  /** Tests only; defaults to the (environment-restricted) API base of app-auth. */
  apiBase?: string;
  /** Tests only; defaults to https://github.com. */
  oauthBase?: string;
  timeoutMs?: number;
};

/**
 * The github.com authorization address of the App's user-to-server OAuth, as the link and sign-in flows use it: PKCE S256 (the browser
 * nonce is the verifier), no sign-up on GitHub's side. `state` is whatever single-use value the caller stored.
 */
export function oauthAuthorizeUrl(config: Pick<GithubAppConfig, "clientId">, input: { redirectUri: string; state: string; nonce: string }): string {
  const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: input.redirectUri, state: input.state, code_challenge: createHash("sha256").update(input.nonce).digest("base64url"), code_challenge_method: "S256", allow_signup: "false" });
  return `${githubWebBase()}/login/oauth/authorize?${q.toString()}`;
}

export type GithubUser = { id: bigint; login: string };
export type UserInstallation = { id: bigint; accountId: bigint; accountLogin: string; accountType: "USER" | "ORGANIZATION" };
export type OrgMembership = { role: string; state: string };

const unavailable = (m: string, status?: number) => new GithubAppError("unavailable", m, status);

const toId = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null);
const accountType = (v: unknown): "USER" | "ORGANIZATION" | null => (v === "User" ? "USER" : v === "Organization" ? "ORGANIZATION" : null);

type Sent = { status: number; json: unknown; headers: Headers };
async function send(deps: ConnectDeps, url: string, init: RequestInit): Promise<Sent> {
  const ms = deps.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(url, { ...init, redirect: "error", signal: ac.signal });
    } catch {
      throw unavailable("GitHub could not be reached.");
    }
    let text: string;
    try {
      text = await readCapped(res);
    } catch (e) {
      if (e instanceof GithubAppError) throw e;
      throw unavailable("GitHub returned an unreadable response.", res.status);
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** A 403 or 429 that is GitHub's rate limiting (primary, secondary or abuse): the token is fine, the answer is only late. */
export function isRateLimited(r: Sent): boolean {
  if (r.status === 429) return true;
  if (r.status !== 403) return false;
  const message = String(obj(r.json)?.message ?? "");
  return r.headers.get("x-ratelimit-remaining") === "0" || r.headers.has("retry-after") || /rate limit|abuse|secondary/i.test(message);
}
/**
 * Does this answer say the person's TOKEN is dead? Only a 401, or a 403 that says so in words (bad credentials, a revoked token, SAML
 * enforcement), counts. Rate limiting, any other 403, 5xx and network failures never do: they throw "unavailable" and the link survives.
 */
export function tokenIsDead(r: Sent): boolean {
  if (r.status === 401) return true;
  if (r.status !== 403 || isRateLimited(r)) return false;
  return /bad credentials|revoked|saml|token (has )?expired|requires authentication/i.test(String(obj(r.json)?.message ?? ""));
}

const apiBase = (deps: ConnectDeps) => (deps.apiBase ?? githubApiBase()).replace(/\/+$/, "");
const oauthBase = (deps: ConnectDeps) => (deps.oauthBase ?? githubWebBase()).replace(/\/+$/, "");
const asUser = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" });

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** What GitHub's token endpoint hands out. The lifetimes are whatever GitHub says (seconds); null means GitHub gave none (a token that does not expire). */
export type UserTokens = { accessToken: string; refreshToken: string | null; expiresInSeconds: number | null; refreshExpiresInSeconds: number | null };

const seconds = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 10 * 365 * 86400 ? Math.floor(v) : null);

function tokensOf(r: { status: number; json: unknown }): { tokens: UserTokens | null; error: string | null } {
  const j = obj(r.json);
  const token = j?.access_token;
  const error = typeof j?.error === "string" ? j.error : null;
  if (r.status !== 200 || error || typeof token !== "string" || token.length === 0) return { tokens: null, error };
  return {
    tokens: { accessToken: token, refreshToken: typeof j?.refresh_token === "string" && j.refresh_token ? j.refresh_token : null, expiresInSeconds: seconds(j?.expires_in), refreshExpiresInSeconds: seconds(j?.refresh_token_expires_in) },
    error: null,
  };
}

/** The user-to-server tokens for a code, or null when GitHub refuses it (bad, used or expired code, a PKCE mismatch, a wrong secret). Throws only when GitHub cannot be reached. */
export async function exchangeCodeForTokens(config: Pick<GithubAppConfig, "clientId" | "clientSecret">, deps: ConnectDeps, input: { code: string; redirectUri: string; codeVerifier?: string }): Promise<UserTokens | null> {
  const body: Record<string, string> = { client_id: config.clientId, client_secret: config.clientSecret, code: input.code, redirect_uri: input.redirectUri };
  if (input.codeVerifier) body.code_verifier = input.codeVerifier;
  const r = await send(deps, `${oauthBase(deps)}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergeport" }, body: JSON.stringify(body) });
  if (r.status === 429 || r.status >= 500) throw unavailable("GitHub did not accept the request right now.", r.status);
  return tokensOf(r).tokens;
}

/** The user-to-server token for a code (the connect flow keeps nothing but this one string for the length of its callback). */
export async function exchangeCode(config: Pick<GithubAppConfig, "clientId" | "clientSecret">, deps: ConnectDeps, input: { code: string; redirectUri: string; codeVerifier?: string }): Promise<string | null> {
  return (await exchangeCodeForTokens(config, deps, input))?.accessToken ?? null;
}

/**
 * Trades a refresh token for a new pair (GitHub rotates the refresh token: the old one stops working). `"rejected"` means GitHub
 * refused THIS refresh token (`bad_refresh_token`): the person has to link again. Any other refusal or failure throws (nothing is
 * concluded about the person's link from an App-level problem or an outage).
 */
export async function refreshUserTokens(config: Pick<GithubAppConfig, "clientId" | "clientSecret">, deps: ConnectDeps, refreshToken: string): Promise<UserTokens | "rejected"> {
  const body = { client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken };
  const r = await send(deps, `${oauthBase(deps)}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergeport" }, body: JSON.stringify(body) });
  if (r.status === 429 || r.status >= 500) throw unavailable("GitHub did not accept the request right now.", r.status);
  const { tokens, error } = tokensOf(r);
  if (tokens) return tokens;
  if (error === "bad_refresh_token") return "rejected";
  throw unavailable("GitHub did not renew the sign-in.", r.status);
}

/** Best effort: ends the user token at GitHub as soon as the proof is done. A failure changes nothing (the token is not kept either way). */
export async function revokeUserToken(config: Pick<GithubAppConfig, "clientId" | "clientSecret">, deps: ConnectDeps, token: string): Promise<void> {
  try {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    await send({ ...deps, timeoutMs: 5000 }, `${apiBase(deps)}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport", "content-type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    });
  } catch {
    // nothing to do: the token is discarded by the caller regardless
  }
}

/** `GET /user`: who the token belongs to. Null when GitHub refuses the token. */
export async function getUser(deps: ConnectDeps, token: string): Promise<GithubUser | null> {
  const r = await send(deps, `${apiBase(deps)}/user`, { headers: asUser(token) });
  if (tokenIsDead(r)) return null;
  if (r.status !== 200) throw unavailable("GitHub did not answer the user request.", r.status);
  const j = obj(r.json);
  const id = toId(j?.id);
  return id !== null && typeof j?.login === "string" && j.login ? { id, login: j.login } : null;
}

/**
 * `GET /user/emails` (needs the App's "Email addresses (read)" user permission): the person's PRIMARY address, only when GitHub marks it
 * verified. `email: null` means there is none to trust (no primary, primary unverified, none listed). `forbidden` means the App lacks the
 * permission (403/404), which is a server setup problem, not something about the person. The result is a raw string from GitHub: the caller
 * normalizes it. Throws "unavailable" when GitHub cannot be reached or answers oddly; null token refusal is `forbidden` too (401).
 */
export async function getVerifiedPrimaryEmail(deps: ConnectDeps, token: string): Promise<{ kind: "ok"; email: string | null } | { kind: "forbidden" }> {
  const r = await send(deps, `${apiBase(deps)}/user/emails?per_page=100`, { headers: asUser(token) });
  if (isRateLimited(r)) throw unavailable("GitHub did not answer the email request.", r.status);
  if (r.status === 401 || r.status === 403 || r.status === 404) return { kind: "forbidden" };
  if (r.status !== 200 || !Array.isArray(r.json)) throw unavailable("GitHub did not answer the email request.", r.status);
  for (const item of r.json as unknown[]) {
    const o = obj(item);
    if (o?.primary === true && o?.verified === true && typeof o.email === "string" && o.email) return { kind: "ok", email: o.email };
  }
  return { kind: "ok", email: null };
}

/** `GET /user/installations`, all pages: the installations of THIS App the person can access. Null when GitHub refuses the token. */
export async function listUserInstallations(deps: ConnectDeps, token: string): Promise<UserInstallation[] | null> {
  const out: UserInstallation[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const r = await send(deps, `${apiBase(deps)}/user/installations?per_page=100&page=${page}`, { headers: asUser(token) });
    if (tokenIsDead(r)) return null;
    if (r.status !== 200) throw unavailable("GitHub did not answer the installations request.", r.status);
    const j = obj(r.json);
    const items = Array.isArray(j?.installations) ? (j.installations as unknown[]) : null;
    if (!items) throw unavailable("GitHub returned an unexpected installations answer.", r.status);
    for (const it of items) {
      const o = obj(it);
      const acct = obj(o?.account);
      const id = toId(o?.id);
      const accountId = toId(acct?.id);
      const type = accountType(acct?.type);
      if (id !== null && accountId !== null && type && typeof acct?.login === "string") out.push({ id, accountId, accountLogin: acct.login, accountType: type });
    }
    if (items.length < 100) return out;
  }
  return out;
}

/** `GET /user/memberships/orgs/:org`: the caller's own role in the organization. Null on ANY refusal (403, 404, 401) or odd answer: the caller must treat null as "not proved". */
export async function getOrgMembership(deps: ConnectDeps, token: string, org: string): Promise<OrgMembership | null> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) return null;
  const r = await send(deps, `${apiBase(deps)}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: asUser(token) });
  if (r.status !== 200) return null;
  const j = obj(r.json);
  return typeof j?.role === "string" && typeof j?.state === "string" ? { role: j.role, state: j.state } : null;
}

export type UserInstallationRepo = { id: bigint; permission: string };
/** Highest repository permission GitHub reports for the person, from the `permissions` object of a repository. Null when it shows none. */
function permissionOf(v: unknown): string | null {
  const p = obj(v);
  if (!p) return null;
  for (const k of ["admin", "maintain", "push", "triage", "pull"]) if (p[k] === true) return k;
  return null;
}
/** Repositories read per installation: this many pages of 100 at most. */
export const MAX_REPOSITORY_PAGES = 50;

/**
 * `GET /user/installations/:id/repositories`, all pages up to the cap: the repositories of one installation THIS person can access, with
 * their permission. `complete` is false when the cap was reached (the caller must not treat a missing repository as "no access" then).
 * `null` when GitHub refuses (401/403/404: the person cannot use that installation). A repository that shows no permission is left out.
 */
export async function listUserInstallationRepositories(deps: ConnectDeps, token: string, installationId: bigint): Promise<{ repos: UserInstallationRepo[]; complete: boolean } | null> {
  const repos: UserInstallationRepo[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
    const r = await send(deps, `${apiBase(deps)}/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { headers: asUser(token) });
    if (isRateLimited(r) || r.status === 401) throw unavailable("GitHub did not answer the repositories request.", r.status); // late or dead token: not "no access"
    if (r.status === 403 || r.status === 404) return null; // GitHub says this person cannot use that installation
    if (r.status !== 200) throw unavailable("GitHub did not answer the repositories request.", r.status);
    const j = obj(r.json);
    const items = Array.isArray(j?.repositories) ? (j.repositories as unknown[]) : null;
    if (!items) throw unavailable("GitHub returned an unexpected repositories answer.", r.status);
    for (const it of items) {
      const o = obj(it);
      const id = toId(o?.id);
      const permission = permissionOf(o?.permissions);
      if (id !== null && permission) repos.push({ id, permission });
    }
    if (items.length < 100) return { repos, complete: true };
  }
  return { repos, complete: false };
}

/**
 * `GET /app/installations/:id` with the app JWT: the authoritative account, type, repository selection and suspension of an installation.
 * Null when GitHub says it does not exist (404). An unusable App (401) throws a typed error from app-auth's family.
 */
export async function fetchInstallationFacts(config: GithubAppConfig, deps: ConnectDeps, installationId: bigint, now = Date.now()): Promise<InstallationFacts | null> {
  const jwt = signAppJwt(config, now);
  const r = await send(deps, `${apiBase(deps)}/app/installations/${installationId}`, { headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" } });
  if (r.status === 404) return null;
  if (r.status === 401) throw new GithubAppError("app_misconfigured", "GitHub rejected the GitHub App credentials.", 401);
  if (r.status !== 200) throw unavailable("GitHub did not answer the installation request.", r.status);
  const j = obj(r.json);
  const acct = obj(j?.account);
  const id = toId(j?.id);
  const accountId = toId(acct?.id);
  const type = accountType(acct?.type);
  const sel = j?.repository_selection === "all" ? "ALL" : j?.repository_selection === "selected" ? "SELECTED" : null;
  if (id === null || id !== installationId || accountId === null || !type || !sel || typeof acct?.login !== "string" || !acct.login) throw unavailable("GitHub returned an unexpected installation answer.", r.status);
  // A suspension time we cannot read still means suspended (never fail open).
  const parsed = typeof j?.suspended_at === "string" ? new Date(j.suspended_at) : null;
  const suspendedAt = j?.suspended_at == null ? null : parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date(now);
  return { installationId: id, accountGithubId: accountId, accountLogin: acct.login, accountType: type, repositorySelection: sel, suspendedAt };
}
