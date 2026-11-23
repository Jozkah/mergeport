import type { Db } from "@/lib/db";
import { loadViewer, requireWrite, subjectOf, type Viewer } from "@/lib/authz/viewer";
import { can } from "@/lib/authz/roles";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { mcpResourceUrl } from "@/lib/oauth-urls";
import { audit } from "./audit";

/**
 * Personal access tokens for the hosted MCP endpoint (docs/mcp.md). A token is bound to ONE workspace and acts as ONE person there.
 * Only the sha256 of the secret is stored; the secret itself is returned once, by `createApiToken`. `authenticateApiToken` loads the
 * person's viewer fresh on every call, so a role change, a removal or a restricted space applies on the very next request.
 */
export const TOKEN_PREFIX = "mp_pat_";
/** `mp_pat_` (a personal token) or `mp_oat_` (issued to a connected app, see oauth.ts) and 32 random bytes as base64url (43 characters). */
const TOKEN_SHAPE = /^mp_(?:pat|oat)_[A-Za-z0-9_-]{43}$/;
export const EXPIRY_DAYS = [30, 90, 365] as const;
export const TOKEN_NAME_MAX = 60;
/** At most this many live tokens per person and workspace. */
export const TOKENS_PER_PERSON = 20;
/** lastUsedAt is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;

export type ApiScope = "READ" | "WRITE";
export type TokenAuth = { tokenId: string; scope: ApiScope; viewer: Viewer };

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/** Creates a token for the caller. A READER may only hold a READ token (a WRITE one could never write anyway, and would mislead). Returns the secret ONCE. */
export async function createApiToken(db: Db, v: Viewer, input: { name: string; scope: string; expiresInDays?: number | null }, now = new Date()) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw new ValidationError("Give the token a name");
  if (name.length > TOKEN_NAME_MAX || !noControl(name)) throw new ValidationError(`The name can have at most ${TOKEN_NAME_MAX} characters`);
  if (input.scope !== "READ" && input.scope !== "WRITE") throw new ValidationError("Choose read or write access");
  if (input.scope === "WRITE" && !can(subjectOf(v), "write")) throw new ValidationError("Your role is read-only in this workspace, so a token can only read");
  const days = input.expiresInDays ?? null;
  if (days !== null && !(EXPIRY_DAYS as readonly number[]).includes(days)) throw new ValidationError("Choose 30, 90 or 365 days, or no expiry");
  const live = await db.apiToken.count({ where: { workspaceId: v.workspaceId, userId: v.userId, revokedAt: null, kind: "PAT" } });
  if (live >= TOKENS_PER_PERSON) throw new ValidationError(`You can have at most ${TOKENS_PER_PERSON} active tokens. Revoke one you no longer use`);
  const secret = TOKEN_PREFIX + randomToken(32);
  const row = await db.apiToken.create({
    data: {
      workspaceId: v.workspaceId,
      userId: v.userId,
      name,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, TOKEN_PREFIX.length + 5),
      scope: input.scope,
      expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
    },
  });
  await audit(db, v, "apitoken.create", { type: "ApiToken", id: row.id }, { scope: row.scope, expiresAt: row.expiresAt?.toISOString() ?? null });
  return { id: row.id, secret, prefix: row.prefix };
}

export type TokenRow = { id: string; name: string; prefix: string; scope: ApiScope; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; owner: string; mine: boolean; state: "active" | "expired" | "revoked" };

/** Your own tokens; an administrator sees every token of the workspace. Never the hash. */
export async function listApiTokens(db: Db, v: Viewer, now = new Date()): Promise<TokenRow[]> {
  const rows = await db.apiToken.findMany({
    where: { workspaceId: v.workspaceId, kind: "PAT", ...(v.isAdmin ? {} : { userId: v.userId }) },
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    take: 200,
    include: { user: { select: { login: true, email: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: r.scope,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    owner: r.user.email ?? `@${r.user.login}`,
    mine: r.userId === v.userId,
    state: r.revokedAt ? "revoked" : r.expiresAt && r.expiresAt <= now ? "expired" : "active",
  }));
}

/** Revokes your own token; an administrator may revoke anyone's in the workspace. Safe to repeat. */
export async function revokeApiToken(db: Db, v: Viewer, id: string, now = new Date()) {
  const t = await db.apiToken.findFirst({ where: { id, workspaceId: v.workspaceId }, select: { id: true, userId: true, revokedAt: true } });
  if (!t) throw new NotFoundError();
  if (t.userId !== v.userId && !v.isAdmin) throw new ForbiddenError("You can only revoke your own tokens");
  if (t.revokedAt) return;
  await db.apiToken.updateMany({ where: { id, workspaceId: v.workspaceId, revokedAt: null }, data: { revokedAt: now } });
  await audit(db, v, "apitoken.revoke", { type: "ApiToken", id }, { own: t.userId === v.userId });
}

/** The secret from an `Authorization: Bearer` header, or null when the header is absent or not shaped like a Mergeport token. */
export function bearerSecret(header: string | null): string | null {
  const m = /^Bearer ([^\s]+)$/i.exec((header ?? "").trim());
  return m && TOKEN_SHAPE.test(m[1]) ? m[1] : null;
}

/**
 * The one way a secret becomes a caller. Null for anything wrong (unknown, revoked, expired, owner no longer an ACTIVE member): the
 * caller cannot tell which, and neither can anyone watching the answers. The viewer is loaded fresh for the token's own workspace.
 */
export async function authenticateApiToken(db: Db, secret: string, now = new Date()): Promise<TokenAuth | null> {
  const hash = sha256(secret);
  const t = await db.apiToken.findUnique({ where: { tokenHash: hash } });
  if (!t || !safeEqual(t.tokenHash, hash)) return null;
  if (t.revokedAt || (t.expiresAt && t.expiresAt <= now)) return null;
  if (t.kind === "OAUTH") {
    // Issued to a connected app: only for this server's own /api/mcp address, and only while the person's consent stands.
    const own = mcpResourceUrl();
    if (!own || !t.audience || !safeEqual(t.audience, own) || !t.grantId) return null;
    const grant = await db.oAuthGrant.findFirst({ where: { id: t.grantId, workspaceId: t.workspaceId, revokedAt: null }, select: { id: true } });
    if (!grant) return null;
  }
  const viewer = await loadViewer(db, t.userId, t.workspaceId, { now });
  if (!viewer || viewer.workspaceId !== t.workspaceId) return null;
  if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
    await db.apiToken.updateMany({ where: { id: t.id, workspaceId: t.workspaceId }, data: { lastUsedAt: now } }).catch(() => {});
    if (t.grantId) await db.oAuthGrant.updateMany({ where: { id: t.grantId, workspaceId: t.workspaceId }, data: { lastUsedAt: now } }).catch(() => {});
  }
  // A WRITE token held by someone who is now a READER stays a token that can read: tools check the role again on every write.
  return { tokenId: t.id, scope: t.scope, viewer };
}

/** Both checks a write needs: the token says write AND the person's role allows it right now. */
export function assertTokenMayWrite(auth: { scope: ApiScope; viewer: Viewer }) {
  if (auth.scope !== "WRITE") throw new ForbiddenError("This token is read-only. Create a token with write access to change things.");
  requireWrite(auth.viewer);
}
