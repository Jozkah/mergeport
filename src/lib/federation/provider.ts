import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { activeWorkspaces } from "@/lib/auth/workspaces";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/authz/roles";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { normaliseOrigin, pkceChallenge, keyHash } from "./config";
import { nowOf, type FedCtx } from "./context";
import { recordEvent } from "./events";
import { DEFAULT_POLICY, checkOrigin, loadPolicy } from "./policy";

/**
 * Provider side: this instance OWNS the data and decides, on every request, whether a linked instance may read it.
 * A grant is "what <user> approved for <client instance> in <workspace>"; reading through it always goes through
 * loadViewer(grant.user, grant.workspace), so roles, restricted spaces and project membership are exactly what that person sees.
 */
export const CODE_TTL_MS = 60_000;
export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
export const TOKEN_MAX_MS = 180 * 24 * 3600 * 1000;
const RENEW_EVERY_MS = 60_000;

export const CALLBACK_PATH = "/federation/callback";
export const WELL_KNOWN_PATH = "/.well-known/mergeport-federation";

/** The discovery document. `inbound` is only a hint (the server ceiling); each workspace decides for itself at approval and on every request. */
export function discoveryDocument(ctx: FedCtx) {
  const o = ctx.selfOrigin;
  return {
    protocol: "mergeport-federation",
    version: 1,
    authorization_endpoint: `${o}/federation/authorize`,
    token_endpoint: `${o}/api/federation/v1/token`,
    revoke_endpoint: `${o}/api/federation/v1/revoke`,
    api_base: `${o}/api/federation/v1`,
    scopes: ["read"],
    code_challenge_methods: ["S256"],
    inbound: ctx.config.mode !== "off",
  };
}

// ---------- authorization request ----------

export type AuthorizeRequest = { clientOrigin: string; redirectUri: string; state: string; codeChallenge: string; scope: "read" };

/**
 * Validates the parameters of /federation/authorize. The redirect target is NEVER taken from the request as given: it must equal
 * `<client_origin>/federation/callback` exactly, so there is nothing to redirect elsewhere. A bad request is shown as an error page.
 */
export function parseAuthorizeRequest(ctx: Pick<FedCtx, "config" | "selfOrigin">, p: Record<string, string | undefined>): { ok: true; req: AuthorizeRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const clientOrigin = p.client_origin ?? "";
  if (normaliseOrigin(clientOrigin, ctx.config.allowInsecure) !== clientOrigin) return bad("The requesting instance is not a valid address.");
  if (clientOrigin === ctx.selfOrigin) return bad("An instance cannot link to itself.");
  if (p.redirect_uri !== `${clientOrigin}${CALLBACK_PATH}`) return bad("The return address does not belong to the requesting instance.");
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(p.state ?? "")) return bad("The request is incomplete (state).");
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? "") || (p.code_challenge_method ?? "S256") !== "S256") return bad("The request is incomplete (code challenge).");
  if ((p.scope ?? "read") !== "read") return bad("Only read-only access can be requested.");
  if (p.response_type !== undefined && p.response_type !== "code") return bad("Unsupported response type.");
  const ceiling = checkOrigin("inbound", clientOrigin, ctx.config, { ...DEFAULT_POLICY, inboundMode: "any" });
  if (!ceiling.ok) return bad(ceiling.reason);
  return { ok: true, req: { clientOrigin, redirectUri: p.redirect_uri, state: p.state!, codeChallenge: p.code_challenge!, scope: "read" } };
}

export type Eligible = { workspaceId: string; name: string; role: string };

/** The signed-in person's workspaces whose policy lets `clientOrigin` link in. The role is shown on the approval page. */
export async function eligibleWorkspaces(ctx: FedCtx, userId: string, clientOrigin: string): Promise<{ eligible: Eligible[]; refused: number }> {
  const eligible: Eligible[] = [];
  let refused = 0;
  for (const w of await activeWorkspaces(ctx.db, userId)) {
    const policy = await loadPolicy(ctx.db, w.id);
    if (!checkOrigin("inbound", clientOrigin, ctx.config, policy).ok) {
      refused++;
      continue;
    }
    const v = await loadViewer(ctx.db, userId, w.id);
    if (v) eligible.push({ workspaceId: w.id, name: w.name, role: v.role });
  }
  return { eligible, refused };
}

const withParams = (base: string, params: Record<string, string>) => `${base}?${new URLSearchParams(params).toString()}`;

/** The person pressed Approve for one of their workspaces. Re-checks everything the page showed; returns where to send the browser. */
export async function approveAuthorization(ctx: FedCtx, userId: string, req: AuthorizeRequest, workspaceId: string): Promise<{ redirectTo: string }> {
  const { db } = ctx;
  if (!(await take(db, `fed:approve:${userId}`, 20, 3600_000, nowOf(ctx)))) throw new ForbiddenError("Too many approvals. Try again later.");
  const { eligible } = await eligibleWorkspaces(ctx, userId, req.clientOrigin);
  if (!eligible.some((e) => e.workspaceId === workspaceId)) throw new ForbiddenError("That workspace cannot be shared with this instance.");
  const now = nowOf(ctx);
  const code = randomToken(32);
  const grant = await db.federationGrant.create({
    data: { workspaceId, userId, clientOrigin: req.clientOrigin, scope: "read", codeHash: sha256(code), codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), codeChallenge: req.codeChallenge, redirectUri: req.redirectUri },
  });
  await recordEvent(db, { workspaceId, userId, kind: "grant.approved", peerOrigin: req.clientOrigin, grantId: grant.id });
  return { redirectTo: withParams(req.redirectUri, { code, state: req.state }) };
}

export async function denyAuthorization(ctx: FedCtx, userId: string, req: AuthorizeRequest, workspaceId: string | null): Promise<{ redirectTo: string }> {
  if (workspaceId && (await eligibleWorkspaces(ctx, userId, req.clientOrigin)).eligible.some((e) => e.workspaceId === workspaceId)) {
    await recordEvent(ctx.db, { workspaceId, userId, kind: "grant.denied", peerOrigin: req.clientOrigin });
  }
  return { redirectTo: withParams(req.redirectUri, { error: "access_denied", state: req.state }) };
}

// ---------- token endpoint ----------

export type HttpAnswer = { status: number; body: unknown; headers?: Record<string, string> };
const fail = (status = 400, error = "invalid_grant"): HttpAnswer => ({ status, body: { error } });
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/**
 * Exchanges a one-time code for an access token. Every failure after the code was found marks it used, so a wrong verifier, a wrong
 * redirect_uri, an expired code or a policy refusal all invalidate it; presenting a used code again revokes the token it produced.
 */
export async function exchangeToken(ctx: FedCtx, body: unknown): Promise<HttpAnswer> {
  const { db } = ctx;
  const now = nowOf(ctx);
  if (!(await take(db, `fed:tok:${ctx.ip ? keyHash(ctx.ip) : "noip"}`, 30, 60_000, now))) return { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = str(b.code, 200);
  const verifier = str(b.code_verifier, 200);
  const redirectUri = str(b.redirect_uri, 400);
  const clientOrigin = str(b.client_origin, 300);
  if (!code || !verifier || !redirectUri || !clientOrigin) return fail(400, "invalid_request");

  const grant = await db.federationGrant.findUnique({ where: { codeHash: sha256(code) } });
  if (!grant) return fail();
  if (grant.codeUsedAt) {
    // Replay of a used code: whatever it produced is revoked.
    await db.federationGrant.updateMany({ where: { id: grant.id, workspaceId: grant.workspaceId, revokedAt: null }, data: { revokedAt: now } });
    await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "grant.revoked", peerOrigin: grant.clientOrigin, grantId: grant.id, meta: { reason: "code replay" } });
    return fail();
  }
  // Burn the code first (atomically: two racing exchanges cannot both pass), then judge it.
  const claimed = await db.federationGrant.updateMany({ where: { id: grant.id, workspaceId: grant.workspaceId, codeUsedAt: null }, data: { codeUsedAt: now } });
  if (claimed.count !== 1) return fail();
  if (!grant.codeExpiresAt || grant.codeExpiresAt <= now) return fail();
  if (clientOrigin !== grant.clientOrigin || redirectUri !== grant.redirectUri) return fail();
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !grant.codeChallenge || !safeEqual(pkceChallenge(verifier), grant.codeChallenge)) return fail();
  const policy = await loadPolicy(db, grant.workspaceId);
  const decision = checkOrigin("inbound", grant.clientOrigin, ctx.config, policy);
  if (!decision.ok) {
    await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "policy.refused", peerOrigin: grant.clientOrigin, grantId: grant.id, meta: { reason: decision.reason, at: "token" } });
    return fail();
  }
  if (!(await loadViewer(db, grant.userId, grant.workspaceId))) return fail();

  const token = randomToken(32);
  const absolute = new Date(grant.createdAt.getTime() + TOKEN_MAX_MS);
  const expiresAt = new Date(Math.min(now.getTime() + TOKEN_TTL_MS, absolute.getTime()));
  await db.federationGrant.updateMany({ where: { id: grant.id, workspaceId: grant.workspaceId }, data: { tokenHash: sha256(token), expiresAt, absoluteExpiresAt: absolute } });
  await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "grant.token_issued", peerOrigin: grant.clientOrigin, grantId: grant.id });
  return { status: 200, body: { access_token: token, token_type: "Bearer", expires_in: Math.floor((expiresAt.getTime() - now.getTime()) / 1000), scope: "read" }, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } };
}

// ---------- using a token ----------

export type Authed = { grantId: string; clientOrigin: string; viewer: Viewer };

/**
 * Bearer token -> grant -> policy -> viewer, on EVERY call. Every failure is the same `null` (the caller answers one uniform 401), so
 * a revoked, expired, unknown, policy-blocked or de-membered grant cannot be told apart from outside.
 */
export async function authenticate(ctx: FedCtx, token: string): Promise<Authed | null> {
  const { db } = ctx;
  const now = nowOf(ctx);
  const grant = await db.federationGrant.findUnique({ where: { tokenHash: sha256(token) } });
  if (!grant || grant.revokedAt || !grant.expiresAt || grant.expiresAt <= now || (grant.absoluteExpiresAt && grant.absoluteExpiresAt <= now)) return null;
  const policy = await loadPolicy(db, grant.workspaceId);
  const decision = checkOrigin("inbound", grant.clientOrigin, ctx.config, policy);
  if (!decision.ok) {
    if (await take(db, `fed:refused:${grant.id}`, 1, 600_000, now)) await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "policy.refused", peerOrigin: grant.clientOrigin, grantId: grant.id, meta: { reason: decision.reason, at: "use" } });
    return null;
  }
  const viewer = await loadViewer(db, grant.userId, grant.workspaceId);
  if (!viewer) return null;
  if (!grant.lastUsedAt) await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "grant.first_use", peerOrigin: grant.clientOrigin, grantId: grant.id });
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() >= RENEW_EVERY_MS) {
    const limit = grant.absoluteExpiresAt ?? new Date(grant.createdAt.getTime() + TOKEN_MAX_MS);
    await db.federationGrant.updateMany({ where: { id: grant.id, workspaceId: grant.workspaceId, revokedAt: null }, data: { lastUsedAt: now, expiresAt: new Date(Math.min(now.getTime() + TOKEN_TTL_MS, limit.getTime())) } });
  }
  return { grantId: grant.id, clientOrigin: grant.clientOrigin, viewer };
}

/** The peer unlinked: the token dies now. Unknown tokens answer the same way, so the endpoint reveals nothing. */
export async function revokeByToken(ctx: FedCtx, token: string): Promise<void> {
  const { db } = ctx;
  const grant = await db.federationGrant.findUnique({ where: { tokenHash: sha256(token) } });
  if (!grant || grant.revokedAt) return;
  await db.federationGrant.updateMany({ where: { id: grant.id, workspaceId: grant.workspaceId, revokedAt: null }, data: { revokedAt: nowOf(ctx) } });
  await recordEvent(db, { workspaceId: grant.workspaceId, userId: grant.userId, kind: "grant.revoked", peerOrigin: grant.clientOrigin, grantId: grant.id, meta: { by: "peer" } });
}

// ---------- managing grants (the user's "Linked apps" and the administrators' list) ----------

export type GrantRow = { id: string; userId: string; clientOrigin: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revoked: boolean };

const live = (now: Date) => ({ tokenHash: { not: null }, revokedAt: null, expiresAt: { gt: now } });
const row = (g: { id: string; userId: string; clientOrigin: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null }): GrantRow => ({ id: g.id, userId: g.userId, clientOrigin: g.clientOrigin, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, expiresAt: g.expiresAt, revoked: g.revokedAt !== null });

/** The signed-in person's own live grants in this workspace. */
export async function myGrants(db: Db, v: Pick<Viewer, "workspaceId" | "userId">, now = new Date()): Promise<GrantRow[]> {
  return (await db.federationGrant.findMany({ where: { workspaceId: v.workspaceId, userId: v.userId, ...live(now) }, orderBy: { createdAt: "desc" }, take: 100 })).map(row);
}

/** Administrators: every live grant of the workspace, with the person's name. */
export async function workspaceGrants(db: Db, v: Viewer, now = new Date()): Promise<(GrantRow & { who: string })[]> {
  if (!can(v, "manageSpaces")) throw new ForbiddenError("Administrator only");
  const rows = await db.federationGrant.findMany({ where: { workspaceId: v.workspaceId, ...live(now) }, include: { user: { select: { login: true, name: true, email: true } } }, orderBy: { createdAt: "desc" }, take: 500 });
  return rows.map((g) => ({ ...row(g), who: g.user.name ?? g.user.email ?? `@${g.user.login}` }));
}

/** A person revokes their own grant; an administrator any grant of the workspace. Anything else is NotFound. */
export async function revokeGrant(db: Db, v: Viewer, grantId: string): Promise<void> {
  const g = await db.federationGrant.findFirst({ where: { id: grantId, workspaceId: v.workspaceId } });
  if (!g || (g.userId !== v.userId && !can(v, "manageSpaces"))) throw new NotFoundError();
  if (g.revokedAt) return;
  await db.federationGrant.updateMany({ where: { id: g.id, workspaceId: v.workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
  await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "grant.revoked", peerOrigin: g.clientOrigin, grantId: g.id, meta: { by: g.userId === v.userId ? "owner" : "admin" } });
}

/** Administrators: end every grant a client instance holds in this workspace. */
export async function revokeAllFromOrigin(db: Db, v: Viewer, origin: string): Promise<number> {
  if (!can(v, "manageSpaces")) throw new ForbiddenError("Administrator only");
  if (typeof origin !== "string" || origin.length > 300) throw new ValidationError("Choose an instance.");
  const r = await db.federationGrant.updateMany({ where: { workspaceId: v.workspaceId, clientOrigin: origin, revokedAt: null }, data: { revokedAt: new Date() } });
  await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "grant.revoked", peerOrigin: origin, meta: { by: "admin", all: true, count: r.count } });
  return r.count;
}
