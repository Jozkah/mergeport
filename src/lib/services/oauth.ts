import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import { can, type Role } from "@/lib/authz/roles";
import { loadViewer, subjectOf, type Viewer } from "@/lib/authz/viewer";
import { take } from "@/lib/auth/rate-limit";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { mcpResourceUrl } from "@/lib/oauth-urls";
import { audit } from "./audit";

/**
 * OAuth 2.1 for the hosted MCP endpoint (docs/mcp.md, "OAuth"), so a custom connector that cannot send a header can still connect. Public
 * clients that register themselves, authorization code with PKCE S256 (required), refresh tokens that rotate. An access token is an
 * ApiToken row (kind OAUTH, one hour, hashed, audience = the /api/mcp address), so every check, limit and revocation of a personal access
 * token applies to it unchanged. Everything hangs off an OAuthGrant (one person, one app, one workspace): revoking it ends them all.
 */
export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const MAX_CLIENTS = 1000;
/** Past this share of the cap, clients nobody ever authorized are forgotten after an hour (the 1-day purge still runs when full). Clients with a grant are never deleted. */
const PURGE_AT = MAX_CLIENTS * 0.8;
export const CLIENT_NAME_MAX = 80;
export const MAX_REDIRECT_URIS = 5;
const CODES_PER_HOUR = 20;

export const ACCESS_PREFIX = "mp_oat_";
const REFRESH_PREFIX = "mp_ort_";
const CODE_PREFIX = "mp_oac_";

/** An OAuth error answer (RFC 6749 section 5.2): `code` is the `error` value. */
export class OAuthError extends Error {
  constructor(readonly code: string, readonly description: string, readonly status = 400) {
    super(description);
  }
}

// ---------- clients ----------

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** https, or http on a loopback name only. No fragment, no credentials, no wildcard, no other scheme (a custom scheme can be claimed by any app). */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return false;
  if (/[\u0000- \u007f*\\]/.test(raw) || raw.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  return u.protocol === "http:" && LOOPBACK_HOSTS.includes(u.hostname);
}

export async function registerClient(db: Db, input: { name: unknown; redirectUris: unknown }, now = new Date()) {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > CLIENT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw new OAuthError("invalid_client_metadata", `client_name is required, up to ${CLIENT_NAME_MAX} characters, no control characters`);
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} addresses`);
  if (!uris.every(validRedirectUri)) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be https, or http on localhost, 127.0.0.1 or [::1], with no fragment, credentials or wildcard");
  const redirectUris = [...new Set(uris as string[])];
  let count = await db.oAuthClient.count();
  if (count > PURGE_AT) {
    // Filling up: forget apps nobody authorized within an hour (a person consents within minutes), so spam cannot keep the table full.
    await db.oAuthClient.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 3_600_000) }, grants: { none: {} } } });
    count = await db.oAuthClient.count();
  }
  if (count >= MAX_CLIENTS) {
    await db.oAuthClient.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) }, grants: { none: {} } } });
    if ((await db.oAuthClient.count()) >= MAX_CLIENTS) throw new OAuthError("temporarily_unavailable", "Too many registered apps right now. Try again later.", 503);
  }
  const c = await db.oAuthClient.create({ data: { name, redirectUris } });
  return { clientId: c.id, name: c.name, redirectUris, issuedAt: c.createdAt };
}

// ---------- the authorization request ----------

export type AuthorizeRequest = { clientId: string; clientName: string; redirectUri: string; state?: string; codeChallenge: string; resource: string; wantsWrite: boolean };
export type AuthorizeParse =
  | { ok: true; request: AuthorizeRequest }
  /** Never redirect: the client or the redirect address cannot be trusted. */
  | { ok: false; fatal: true; message: string }
  /** The redirect address is registered; the error goes back to it (RFC 6749 section 4.1.2.1). */
  | { ok: false; fatal: false; redirectUri: string; state?: string; error: string; description: string };

const S256 = /^[A-Za-z0-9_-]{43}$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

export async function parseAuthorize(db: Db, q: Record<string, unknown>): Promise<AuthorizeParse> {
  const clientId = str(q.client_id, 64);
  const client = clientId ? await db.oAuthClient.findUnique({ where: { id: clientId } }) : null;
  if (!client) return { ok: false, fatal: true, message: "This app is not registered with Mergeport." };
  const redirectUri = str(q.redirect_uri, 2000);
  const registered = Array.isArray(client.redirectUris) ? (client.redirectUris as unknown[]) : [];
  if (!redirectUri || !registered.some((r) => typeof r === "string" && safeEqual(r, redirectUri))) return { ok: false, fatal: true, message: "The address this app asked to return to is not the one it registered." };
  const state = q.state === undefined ? undefined : str(q.state, 512);
  if (q.state !== undefined && (state === undefined || /[\u0000-\u001f\u007f]/.test(state))) return { ok: false, fatal: true, message: "The request is malformed." };
  const fail = (error: string, description: string): AuthorizeParse => ({ ok: false, fatal: false, redirectUri, state, error, description });
  if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const challenge = str(q.code_challenge, 128);
  if (!challenge || !S256.test(challenge)) return fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters).");
  const own = mcpResourceUrl();
  const resource = q.resource === undefined ? own : str(q.resource, 2000);
  if (!own || resource !== own) return fail("invalid_target", "resource must be this server's /api/mcp address.");
  const scopes = (str(q.scope, 200) ?? "").split(/\s+/);
  return { ok: true, request: { clientId: client.id, clientName: client.name, redirectUri, state, codeChallenge: challenge, resource: own, wantsWrite: scopes.includes("write") || scopes.includes("mcp:write") } };
}

export type Membership = { id: string; name: string; role: Role };
/** The workspaces this person may authorize an app for: their own ACTIVE memberships. */
export async function membershipsOf(db: Db, userId: string): Promise<Membership[]> {
  const rows = await db.member.findMany({ where: { userId, status: "ACTIVE" }, select: { role: true, workspace: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({ id: r.workspace.id, name: r.workspace.name, role: r.role }));
}

/** Consent given: one single-use code for this person, workspace and app. READ unless WRITE was chosen AND the role writes. */
export async function issueCode(db: Db, userId: string, input: { workspaceId: string; scope: string; request: AuthorizeRequest }, now = new Date()): Promise<string> {
  const v = await loadViewer(db, userId, input.workspaceId, { now });
  if (!v) throw new ValidationError("You are not a member of that workspace");
  if (input.scope !== "READ" && input.scope !== "WRITE") throw new ValidationError("Choose read or write access");
  if (input.scope === "WRITE" && !can(subjectOf(v), "write")) throw new ValidationError("Your role in this workspace is read-only, so an app can only read there");
  if (!(await take(db, `oauth:code:${userId}`, CODES_PER_HOUR, 3_600_000, now))) throw new ValidationError("Too many authorizations. Try again later");
  await db.oAuthCode.deleteMany({ where: { workspaceId: v.workspaceId, expiresAt: { lt: new Date(now.getTime() - 3_600_000) } } });
  const secret = CODE_PREFIX + randomToken(32);
  const r = input.request;
  await db.oAuthCode.create({
    data: { codeHash: sha256(secret), workspaceId: v.workspaceId, userId, clientId: r.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, scope: input.scope, resource: r.resource, expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
  });
  await audit(db, v, "oauth.authorize", { type: "OAuthClient", id: r.clientId }, { scope: input.scope });
  return secret;
}

// ---------- the token endpoint ----------

export type Issued = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: "read" | "write" };

async function mint(db: Db, grant: { id: string; workspaceId: string; userId: string; resource: string; editAllowed: boolean }, clientName: string, scope: "READ" | "WRITE", now: Date): Promise<Issued> {
  const access = ACCESS_PREFIX + randomToken(32);
  const refresh = REFRESH_PREFIX + randomToken(32);
  await db.apiToken.create({
    data: { workspaceId: grant.workspaceId, userId: grant.userId, name: clientName.slice(0, 60), tokenHash: sha256(access), prefix: access.slice(0, ACCESS_PREFIX.length + 5), scope, editAllowed: scope === "WRITE" && grant.editAllowed, kind: "OAUTH", grantId: grant.id, audience: grant.resource, expiresAt: new Date(now.getTime() + ACCESS_TTL_MS) },
  });
  await db.oAuthRefresh.create({ data: { tokenHash: sha256(refresh), workspaceId: grant.workspaceId, grantId: grant.id, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) } });
  // Old rows nobody can use any more.
  await db.apiToken.deleteMany({ where: { workspaceId: grant.workspaceId, grantId: grant.id, expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  await db.oAuthRefresh.deleteMany({ where: { workspaceId: grant.workspaceId, grantId: grant.id, expiresAt: { lt: now } } });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scope === "WRITE" ? "write" : "read" };
}

const capScope = (scope: "READ" | "WRITE", v: Viewer): "READ" | "WRITE" => (scope === "WRITE" && can(subjectOf(v), "write") ? "WRITE" : "READ");
const invalidGrant = (why = "The code or token is not valid.") => new OAuthError("invalid_grant", why);

/** Ends a grant and everything issued under it: access tokens stop at once, refresh tokens can never be used. Safe to repeat. */
export async function revokeGrantNow(db: Db, workspaceId: string, grantId: string, now = new Date()) {
  await db.oAuthGrant.updateMany({ where: { id: grantId, workspaceId, revokedAt: null }, data: { revokedAt: now } });
  await db.apiToken.updateMany({ where: { workspaceId, grantId, revokedAt: null }, data: { revokedAt: now } });
  await db.oAuthRefresh.updateMany({ where: { workspaceId, grantId, usedAt: null }, data: { usedAt: now } });
}

export async function exchangeCode(db: Db, p: { code: string; clientId: string; redirectUri: string; verifier: string; resource?: string }, now = new Date()): Promise<Issued> {
  const row = await db.oAuthCode.findUnique({ where: { codeHash: sha256(p.code) } });
  if (!row) throw invalidGrant();
  if (row.usedAt) {
    // A code is used once. Seeing it again means it leaked: whatever it already bought is revoked.
    if (row.grantId) {
      await revokeGrantNow(db, row.workspaceId, row.grantId, now);
      await audit(db, { workspaceId: row.workspaceId, userId: null }, "oauth.code-replay", { type: "OAuthGrant", id: row.grantId });
    }
    throw invalidGrant();
  }
  // Claim first (one conditional UPDATE): a wrong verifier or client burns the code, so guessing is not possible, and two requests cannot both win.
  const claimed = await db.oAuthCode.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (claimed.count !== 1) throw invalidGrant();
  if (row.clientId !== p.clientId || !safeEqual(row.redirectUri, p.redirectUri)) throw invalidGrant();
  if (p.resource !== undefined && p.resource !== row.resource) throw new OAuthError("invalid_target", "resource does not match the authorization.");
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.verifier)) throw invalidGrant("code_verifier is not valid.");
  if (!safeEqual(createHash("sha256").update(p.verifier).digest("base64url"), row.codeChallenge)) throw invalidGrant("The code_verifier does not match the code_challenge.");
  const v = await loadViewer(db, row.userId, row.workspaceId, { now });
  if (!v) throw invalidGrant();
  const client = await db.oAuthClient.findUnique({ where: { id: row.clientId } });
  if (!client) throw invalidGrant();
  const scope = capScope(row.scope, v);
  const grant = await db.oAuthGrant.create({ data: { workspaceId: row.workspaceId, userId: row.userId, clientId: row.clientId, scope, editAllowed: scope === "WRITE", resource: row.resource } });
  await db.oAuthCode.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data: { grantId: grant.id } });
  return mint(db, grant, client.name, scope, now);
}

export async function exchangeRefresh(db: Db, p: { refreshToken: string; clientId: string; resource?: string }, now = new Date()): Promise<Issued> {
  const row = await db.oAuthRefresh.findUnique({ where: { tokenHash: sha256(p.refreshToken) } });
  if (!row) throw invalidGrant();
  const grant = await db.oAuthGrant.findFirst({ where: { id: row.grantId, workspaceId: row.workspaceId }, include: { client: { select: { name: true } } } });
  if (!grant || grant.clientId !== p.clientId || grant.revokedAt) throw invalidGrant();
  const reuse = async () => {
    // A refresh token is used once. An old one coming back means two parties hold it: the whole family goes.
    await revokeGrantNow(db, grant.workspaceId, grant.id, now);
    await audit(db, { workspaceId: grant.workspaceId, userId: null }, "oauth.refresh-reuse", { type: "OAuthGrant", id: grant.id });
    return invalidGrant();
  };
  if (row.usedAt) throw await reuse();
  if (row.expiresAt <= now) throw invalidGrant();
  const claimed = await db.oAuthRefresh.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) throw await reuse();
  if (p.resource !== undefined && p.resource !== grant.resource) throw new OAuthError("invalid_target", "resource does not match the authorization.");
  const v = await loadViewer(db, grant.userId, grant.workspaceId, { now });
  if (!v) {
    await revokeGrantNow(db, grant.workspaceId, grant.id, now);
    throw invalidGrant();
  }
  return mint(db, grant, grant.client.name, capScope(grant.scope, v), now);
}

// ---------- connected apps ----------

export type GrantRow = { id: string; clientName: string; scope: "READ" | "WRITE"; editAllowed: boolean; createdAt: Date; lastUsedAt: Date | null; owner: string; mine: boolean };

/** Your own connected apps; an administrator sees every app connected to the workspace. */
export async function listGrants(db: Db, v: Viewer): Promise<GrantRow[]> {
  const rows = await db.oAuthGrant.findMany({
    where: { workspaceId: v.workspaceId, revokedAt: null, ...(v.isAdmin ? {} : { userId: v.userId }) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { client: { select: { name: true } }, user: { select: { login: true, email: true } } },
  });
  return rows.map((r) => ({ id: r.id, clientName: r.client.name, scope: r.scope, editAllowed: r.editAllowed, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, owner: r.user.email ?? `@${r.user.login}`, mine: r.userId === v.userId }));
}

export async function revokeGrant(db: Db, v: Viewer, id: string, now = new Date()) {
  const g = await db.oAuthGrant.findFirst({ where: { id, workspaceId: v.workspaceId }, select: { id: true, userId: true, revokedAt: true, clientId: true } });
  if (!g) throw new NotFoundError();
  if (g.userId !== v.userId && !v.isAdmin) throw new ForbiddenError("You can only disconnect your own apps");
  if (g.revokedAt) return;
  await revokeGrantNow(db, v.workspaceId, g.id, now);
  await audit(db, v, "oauth.revoke", { type: "OAuthGrant", id: g.id }, { own: g.userId === v.userId });
}
