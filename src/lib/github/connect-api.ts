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

export type GithubUser = { id: bigint; login: string };
export type UserInstallation = { id: bigint; accountId: bigint; accountLogin: string; accountType: "USER" | "ORGANIZATION" };
export type OrgMembership = { role: string; state: string };

const unavailable = (m: string, status?: number) => new GithubAppError("unavailable", m, status);

const toId = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null);
const accountType = (v: unknown): "USER" | "ORGANIZATION" | null => (v === "User" ? "USER" : v === "Organization" ? "ORGANIZATION" : null);

async function send(deps: ConnectDeps, url: string, init: RequestInit): Promise<{ status: number; json: unknown }> {
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
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const apiBase = (deps: ConnectDeps) => (deps.apiBase ?? githubApiBase()).replace(/\/+$/, "");
const oauthBase = (deps: ConnectDeps) => (deps.oauthBase ?? GITHUB_WEB_BASE).replace(/\/+$/, "");
const asUser = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mergeport" });

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The user-to-server token for a code, or null when GitHub refuses it (bad, used or expired code, a PKCE mismatch, a wrong secret). Throws only when GitHub cannot be reached. */
export async function exchangeCode(config: Pick<GithubAppConfig, "clientId" | "clientSecret">, deps: ConnectDeps, input: { code: string; redirectUri: string; codeVerifier?: string }): Promise<string | null> {
  const body: Record<string, string> = { client_id: config.clientId, client_secret: config.clientSecret, code: input.code, redirect_uri: input.redirectUri };
  if (input.codeVerifier) body.code_verifier = input.codeVerifier;
  const r = await send(deps, `${oauthBase(deps)}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergeport" }, body: JSON.stringify(body) });
  if (r.status === 429 || r.status >= 500) throw unavailable("GitHub did not accept the request right now.", r.status);
  const j = obj(r.json);
  const token = j?.access_token;
  return r.status === 200 && typeof token === "string" && token.length > 0 && !j?.error ? token : null;
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
  if (r.status === 401 || r.status === 403) return null;
  if (r.status !== 200) throw unavailable("GitHub did not answer the user request.", r.status);
  const j = obj(r.json);
  const id = toId(j?.id);
  return id !== null && typeof j?.login === "string" && j.login ? { id, login: j.login } : null;
}

/** `GET /user/installations`, all pages: the installations of THIS App the person can access. Null when GitHub refuses the token. */
export async function listUserInstallations(deps: ConnectDeps, token: string): Promise<UserInstallation[] | null> {
  const out: UserInstallation[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const r = await send(deps, `${apiBase(deps)}/user/installations?per_page=100&page=${page}`, { headers: asUser(token) });
    if (r.status === 401 || r.status === 403) return null;
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
