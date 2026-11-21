import { createHmac } from "node:crypto";
import * as client from "openid-client";
import type { Db } from "@/lib/db";
import { randomToken, safeEqual } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/http";
import { cookiesSecure } from "@/lib/public-url";
import { userForOidcLogin, withUniqueRetry, type OidcClaims, type OidcLogin } from "./accounts";

/**
 * Generic OpenID Connect sign-in (authorization code + PKCE + state + nonce). The protocol work (discovery, ID token signature,
 * issuer, audience, expiry and nonce checks, code exchange) is done by `openid-client`; this file owns the flow state and the
 * account rules. `OidcProtocol` is the library boundary: tests replace it with a fake.
 */

export const OIDC_COOKIE = "mp_oidc";
const FLOW_TTL_MS = 10 * 60 * 1000;

export type OidcProvider = { name: string; label: string; issuer: string; clientId: string; clientSecret: string };

const LABELS: Record<string, string> = { google: "Google", microsoft: "Microsoft" };

/** Providers configured through OIDC_<NAME>_ISSUER / _CLIENT_ID / _CLIENT_SECRET. All three must be present. */
export function oidcProviders(envVars: Record<string, string | undefined> = process.env): OidcProvider[] {
  const out: OidcProvider[] = [];
  for (const key of Object.keys(envVars)) {
    const m = /^OIDC_([A-Z][A-Z0-9]*)_ISSUER$/.exec(key);
    if (!m) continue;
    const issuer = envVars[key]?.trim();
    const clientId = envVars[`OIDC_${m[1]}_CLIENT_ID`]?.trim();
    const clientSecret = envVars[`OIDC_${m[1]}_CLIENT_SECRET`]?.trim();
    if (!issuer || !clientId || !clientSecret) continue;
    const name = m[1].toLowerCase();
    out.push({ name, label: LABELS[name] ?? m[1], issuer, clientId, clientSecret });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const findProvider = (name: string) => oidcProviders().find((p) => p.name === name) ?? null;

/** Verified claims from the provider's ID token. */
export type OidcTokenClaims = OidcClaims & { nonce?: string };

export interface OidcProtocol {
  authorizationUrl(p: OidcProvider, a: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  /** Exchanges the code and verifies the ID token (signature, iss, aud, exp, nonce). Throws on any failure. */
  exchange(p: OidcProvider, a: { redirectUri: string; callbackUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<OidcTokenClaims>;
}

const configs = new Map<string, { at: number; config: Promise<client.Configuration> }>();
const CONFIG_TTL_MS = 60 * 60 * 1000;
function configFor(p: OidcProvider): Promise<client.Configuration> {
  const hit = configs.get(p.name);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
  const config = client.discovery(new URL(p.issuer), p.clientId, p.clientSecret);
  config.catch(() => configs.delete(p.name)); // a failed discovery is not cached
  configs.set(p.name, { at: Date.now(), config });
  return config;
}

export const openidClientProtocol: OidcProtocol = {
  async authorizationUrl(p, a) {
    const config = await configFor(p);
    return client.buildAuthorizationUrl(config, {
      redirect_uri: a.redirectUri,
      scope: "openid email profile",
      response_type: "code",
      code_challenge: a.codeChallenge,
      code_challenge_method: "S256",
      state: a.state,
      nonce: a.nonce,
    });
  },
  async exchange(p, a) {
    const config = await configFor(p);
    const tokens = await client.authorizationCodeGrant(config, a.callbackUrl, { pkceCodeVerifier: a.codeVerifier, expectedState: a.state, expectedNonce: a.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims) throw new Error("no id_token");
    return claims as unknown as OidcTokenClaims;
  },
};

let protocol: OidcProtocol = openidClientProtocol;
export function setOidcProtocolForTests(p: OidcProtocol | null) {
  protocol = p ?? openidClientProtocol;
}

// ---- flow state: a short-lived, signed, HttpOnly cookie --------------------------------------------------------------------

type Flow = { p: string; s: string; n: string; v: string; next: string; exp: number };

function secret(): string {
  const s = process.env.MERGEPORT_AUTH_SECRET?.trim();
  if (!s || s.length < 32) throw new Error("MERGEPORT_AUTH_SECRET (at least 32 characters) is required for OIDC sign-in");
  return s;
}
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function sealFlow(f: Flow): string {
  const payload = Buffer.from(JSON.stringify(f)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function openFlow(raw: string | undefined | null, now = Date.now()): Flow | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  if (!safeEqual(raw.slice(dot + 1), sign(payload))) return null;
  try {
    const f = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Flow;
    if (typeof f.p !== "string" || typeof f.s !== "string" || typeof f.n !== "string" || typeof f.v !== "string" || typeof f.exp !== "number") return null;
    return f.exp > now ? f : null;
  } catch {
    return null;
  }
}

export const oidcCookieOptions = (now = Date.now()) => ({ httpOnly: true, sameSite: "lax" as const, secure: cookiesSecure(), path: "/auth/oidc", expires: new Date(now + FLOW_TTL_MS) });

export const redirectUriFor = (origin: string, provider: string) => `${origin}/auth/oidc/${provider}/callback`;

/** Step 1: where to send the browser, and the cookie value that remembers the flow. */
export async function beginOidc(p: OidcProvider, a: { origin: string; next?: string | null; now?: number }): Promise<{ url: URL; cookie: string }> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const url = await protocol.authorizationUrl(p, { redirectUri: redirectUriFor(a.origin, p.name), state, nonce, codeChallenge });
  const cookie = sealFlow({ p: p.name, s: state, n: nonce, v: codeVerifier, next: safeReturnTo(a.next), exp: (a.now ?? Date.now()) + FLOW_TTL_MS });
  return { url, cookie };
}

export type OidcFailure = "flow" | "state" | "provider-error" | "exchange" | "nonce" | "claims";
export type OidcResult = ({ ok: true; next: string } & OidcLogin) | { ok: false; reason: OidcFailure };

/** Step 2: the provider sent the browser back. Checks the flow cookie, state and nonce, then resolves the user. */
export async function completeOidc(db: Db, p: OidcProvider, a: { origin: string; callbackUrl: URL; cookie: string | undefined | null; now?: Date }): Promise<OidcResult> {
  const now = a.now ?? new Date();
  const flow = openFlow(a.cookie, now.getTime());
  if (!flow || flow.p !== p.name) return { ok: false, reason: "flow" };
  if (a.callbackUrl.searchParams.get("error")) return { ok: false, reason: "provider-error" };
  const state = a.callbackUrl.searchParams.get("state");
  if (!state || !safeEqual(state, flow.s)) return { ok: false, reason: "state" };

  let claims: OidcTokenClaims;
  try {
    claims = await protocol.exchange(p, { redirectUri: redirectUriFor(a.origin, p.name), callbackUrl: a.callbackUrl, state: flow.s, nonce: flow.n, codeVerifier: flow.v });
  } catch {
    return { ok: false, reason: "exchange" }; // library errors can quote tokens; nothing from them is logged or shown
  }
  // The library already checked the nonce; compare again so a protocol implementation that forgot cannot weaken the flow.
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, flow.n)) return { ok: false, reason: "nonce" };
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) return { ok: false, reason: "claims" };

  const login = await withUniqueRetry(() => db.$transaction((tx) => userForOidcLogin(tx, p.name, claims, now)));
  return { ok: true, next: safeReturnTo(flow.next), ...login };
}
