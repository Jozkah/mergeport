import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { randomToken, sha256 } from "@/lib/crypto";
import { can } from "@/lib/authz/roles";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, normaliseOrigin, pkceChallenge } from "./config";
import { nowOf, type FedCtx } from "./context";
import { recordEvent } from "./events";
import { canCreateLink, checkOrigin, loadPolicy } from "./policy";
import { CALLBACK_PATH, WELL_KNOWN_PATH } from "./provider";
import { parsePeerBody } from "./schemas";
import { SafeFetchError } from "./safe-fetch";

/**
 * Consumer side: this instance is where the person lives and looks. It holds ONE token per link, encrypted, and never stores the
 * peer's data anywhere but the per-link cache, which only the link's person can read. Nothing here is written back to the peer.
 */
export const PENDING_TTL_MS = 10 * 60_000;
export const CACHE_TTL_MS = 60_000;
const API = "/api/federation/v1";

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
type LiveLink = { id: string; userId: string; peerOrigin: string; status: string };

/** One workspace's link bookkeeping runs one transaction at a time, so counting and then linking cannot race. */
const lockWorkspace = (tx: Tx, workspaceId: string) => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))::text AS locked`;

/** The reason a person may not have one more link to `peer`, or null. `live` is the links that count (their own link excluded by the caller). */
function limitProblem(live: LiveLink[], userId: string, peer: string, policy: { maxLinksPerUser: number; maxPeers: number }): string | null {
  if (live.some((l) => l.userId === userId && l.peerOrigin === peer)) return "You are already linked to that instance. Unlink it first to link again.";
  if (live.filter((l) => l.userId === userId).length >= policy.maxLinksPerUser) return `You can link at most ${policy.maxLinksPerUser} instance${policy.maxLinksPerUser === 1 ? "" : "s"} in this workspace.`;
  const peers = new Set(live.filter((l) => l.status === "ACTIVE").map((l) => l.peerOrigin)); // pending links do not occupy a peer slot; activation decides
  if (!peers.has(peer) && peers.size >= policy.maxPeers) return policy.maxPeers === 0 ? "Linking is not allowed in this workspace." : policy.maxPeers === 1 ? "This workspace can be linked to a single instance, and it already is." : `This workspace can be linked to at most ${policy.maxPeers} instances.`;
  return null;
}

const peerMessage = (e: unknown): string => (e instanceof SafeFetchError ? e.message : "Could not reach that instance.");

// ---------- creating a link ----------

/**
 * Step 1 of the handshake: checks who may link, the policy and the limits, asks the peer for its discovery document through the
 * safe fetcher, remembers a one-use state and a PKCE verifier, and returns where to send the browser. Nothing is trusted from the
 * discovery document except "this is a Mergeport instance that speaks version 1": the endpoints are derived from the origin.
 */
export async function startLink(ctx: FedCtx, v: Viewer, address: string): Promise<{ authorizeUrl: string }> {
  const { db, config } = ctx;
  const now = nowOf(ctx);
  if (!config.key) throw new ValidationError("Linking is not set up on this server (no encryption key).");
  const policy = await loadPolicy(db, v.workspaceId);
  if (!canCreateLink(v.role, policy)) throw new ForbiddenError("Your role cannot link instances in this workspace.");
  const peer = normaliseOrigin(address, config.allowInsecure);
  if (!peer) throw new ValidationError("Enter the address of another Mergeport instance, for example https://mergeport.example.com.");
  if (peer === ctx.selfOrigin) throw new ValidationError("That is this instance. Enter the address of a different one.");
  const decision = checkOrigin("outbound", peer, config, policy);
  if (!decision.ok) {
    await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "policy.refused", peerOrigin: peer, meta: { reason: decision.reason, at: "start" } });
    throw new ForbiddenError(decision.reason);
  }
  if (!(await take(db, `fed:start:${v.userId}`, 10, 3600_000, now))) throw new ConflictError("Too many attempts. Try again in a while.");

  // Early answer before any network call; the same check is repeated under the workspace lock when the pending link is written.
  const early = await db.federationLink.findMany({ where: { workspaceId: v.workspaceId, OR: [{ status: "ACTIVE" }, { status: "PENDING", pendingExpiresAt: { gt: now } }] }, select: { id: true, userId: true, peerOrigin: true, status: true } });
  const earlyProblem = limitProblem(early.filter((l) => !(l.status === "PENDING" && l.userId === v.userId && l.peerOrigin === peer)), v.userId, peer, policy);
  if (earlyProblem) throw new ForbiddenError(earlyProblem);

  let doc: unknown;
  try {
    const res = await ctx.fetch(`${peer}${WELL_KNOWN_PATH}`, { allowInsecure: config.allowInsecure });
    if (res.status !== 200) throw new ValidationError("That address does not look like a Mergeport instance with linking turned on.");
    doc = res.json;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(peerMessage(e));
  }
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  if (d.protocol !== "mergeport-federation" || d.version !== 1) throw new ValidationError("That address does not look like a Mergeport instance that supports linking.");
  if (d.inbound === false) throw new ValidationError("That instance does not accept links.");

  const state = randomToken(32);
  const verifier = randomToken(48);
  const linkId = randomUUID();
  await db.$transaction(async (tx) => {
    await lockWorkspace(tx, v.workspaceId);
    await tx.federationLink.deleteMany({ where: { workspaceId: v.workspaceId, userId: v.userId, peerOrigin: peer, status: "PENDING" } });
    const live = await tx.federationLink.findMany({ where: { workspaceId: v.workspaceId, OR: [{ status: "ACTIVE" }, { status: "PENDING", pendingExpiresAt: { gt: now } }] }, select: { id: true, userId: true, peerOrigin: true, status: true } });
    const problem = limitProblem(live, v.userId, peer, policy);
    if (problem) throw new ForbiddenError(problem);
    await tx.federationLink.create({
      data: { id: linkId, workspaceId: v.workspaceId, userId: v.userId, peerOrigin: peer, status: "PENDING", stateHash: sha256(state), verifierEnc: encryptSecret(verifier, config.key!, `verifier:${linkId}`), pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS) },
    });
  });
  await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "link.started", peerOrigin: peer });
  const qs = new URLSearchParams({ response_type: "code", client_origin: ctx.selfOrigin, redirect_uri: `${ctx.selfOrigin}${CALLBACK_PATH}`, state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", scope: "read" });
  return { authorizeUrl: `${peer}/federation/authorize?${qs.toString()}` };
}

export type CallbackFailure = "invalid" | "denied" | "refused" | "peer";

/**
 * Step 3: the browser came back to /federation/callback. The state must belong to a PENDING link of THIS signed-in person (so a code
 * pushed at someone else's browser links nothing), is single use, and the exchange happens server to server with the PKCE verifier.
 */
export async function completeCallback(ctx: FedCtx, userId: string, p: { code?: string | null; state?: string | null; error?: string | null }): Promise<{ ok: true; linkId: string } | { ok: false; error: string; code: CallbackFailure }> {
  const { db, config } = ctx;
  const now = nowOf(ctx);
  const invalid = { ok: false as const, code: "invalid" as CallbackFailure, error: "This link request is not valid or has expired. Start again from Linked instances." };
  if (!config.key || typeof p.state !== "string" || p.state.length < 16 || p.state.length > 200) return invalid;
  const link = await db.federationLink.findFirst({ where: { stateHash: sha256(p.state), userId, status: "PENDING" } });
  if (!link || !link.pendingExpiresAt || link.pendingExpiresAt <= now || !link.verifierEnc) return invalid;
  // One use: the state is cleared before anything else happens, so a replayed callback finds nothing.
  const consumed = await db.federationLink.updateMany({ where: { id: link.id, workspaceId: link.workspaceId, userId, stateHash: link.stateHash }, data: { stateHash: null } });
  if (consumed.count !== 1) return invalid;
  const settle = async (status: "REVOKED", why: string, kind: "link.denied" | "link.failed") => {
    await db.federationLink.updateMany({ where: { id: link.id, workspaceId: link.workspaceId, userId }, data: { status, revokedAt: now, verifierEnc: null, lastError: why } });
    await recordEvent(db, { workspaceId: link.workspaceId, userId, kind, peerOrigin: link.peerOrigin, linkId: link.id, meta: { reason: why } });
  };
  if (p.error) {
    await settle("REVOKED", "denied", "link.denied");
    return { ok: false, code: "denied", error: "The other instance did not approve the link." };
  }
  if (typeof p.code !== "string" || p.code.length < 16 || p.code.length > 200) {
    await settle("REVOKED", "no code", "link.failed");
    return invalid;
  }
  const policy = await loadPolicy(db, link.workspaceId);
  const decision = checkOrigin("outbound", link.peerOrigin, config, policy);
  const viewer = await loadViewer(db, userId, link.workspaceId);
  if (!decision.ok || !viewer || !canCreateLink(viewer.role, policy)) {
    await recordEvent(db, { workspaceId: link.workspaceId, userId, kind: "policy.refused", peerOrigin: link.peerOrigin, linkId: link.id, meta: { reason: decision.ok ? "role" : decision.reason, at: "callback" } });
    await settle("REVOKED", "refused by policy", "link.failed");
    return { ok: false, code: "refused", error: decision.ok ? "Your role cannot link instances in this workspace." : decision.reason };
  }
  const verifier = decryptSecret(link.verifierEnc, config.key, `verifier:${link.id}`);
  if (!verifier) {
    await settle("REVOKED", "verifier", "link.failed");
    return invalid;
  }
  let token: string | null = null;
  try {
    const res = await ctx.fetch(`${link.peerOrigin}${API}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: p.code, code_verifier: verifier, redirect_uri: `${ctx.selfOrigin}${CALLBACK_PATH}`, client_origin: ctx.selfOrigin }),
      allowInsecure: config.allowInsecure,
    });
    const t = (res.json as { access_token?: unknown } | null)?.access_token;
    if (res.status === 200 && typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t)) token = t;
  } catch (e) {
    await settle("REVOKED", peerMessage(e), "link.failed");
    return { ok: false, code: "peer", error: peerMessage(e) };
  }
  if (!token) {
    await settle("REVOKED", "token refused", "link.failed");
    return { ok: false, code: "peer", error: "The other instance did not accept the link request." };
  }
  // Activation recounts under the workspace lock: concurrent starts may all have passed the early check, only the limit decides here.
  const over = await db.$transaction(async (tx) => {
    await lockWorkspace(tx, link.workspaceId);
    const p = await tx.federationPolicy.findUnique({ where: { workspaceId: link.workspaceId } });
    const live = await tx.federationLink.findMany({ where: { workspaceId: link.workspaceId, status: "ACTIVE", id: { not: link.id } }, select: { id: true, userId: true, peerOrigin: true, status: true } });
    const problem = limitProblem(live, userId, link.peerOrigin, { maxLinksPerUser: p?.maxLinksPerUser ?? policy.maxLinksPerUser, maxPeers: p?.maxPeers ?? policy.maxPeers });
    if (problem) return problem;
    await tx.federationLink.updateMany({ where: { id: link.id, workspaceId: link.workspaceId, userId }, data: { status: "ACTIVE", tokenEnc: encryptSecret(token!, config.key!, `token:${link.id}`), verifierEnc: null, lastError: null, lastUsedAt: now } });
    return null;
  });
  if (over) {
    // The peer already issued a token: hand it back, store nothing.
    await ctx.fetch(`${link.peerOrigin}${API}/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}", allowInsecure: config.allowInsecure }).catch(() => undefined);
    await recordEvent(db, { workspaceId: link.workspaceId, userId, kind: "policy.refused", peerOrigin: link.peerOrigin, linkId: link.id, meta: { reason: over, at: "activate" } });
    await settle("REVOKED", "over the link limit", "link.failed");
    return { ok: false, code: "refused", error: over };
  }
  await recordEvent(db, { workspaceId: link.workspaceId, userId, kind: "link.created", peerOrigin: link.peerOrigin, linkId: link.id });
  // Who we are over there, for the page heading. Best effort: the link is already good.
  try {
    const res = await ctx.fetch(`${link.peerOrigin}${API}/me`, { headers: { authorization: `Bearer ${token}` }, allowInsecure: config.allowInsecure });
    const m = res.json as { workspace?: { name?: unknown }; role?: unknown } | null;
    if (res.status === 200) await db.federationLink.updateMany({ where: { id: link.id, workspaceId: link.workspaceId, userId }, data: { peerWorkspaceName: typeof m?.workspace?.name === "string" ? m.workspace.name.slice(0, 120) : null, peerRole: typeof m?.role === "string" ? m.role.slice(0, 20) : null } });
  } catch {
    /* shown without it */
  }
  return { ok: true, linkId: link.id };
}

// ---------- listing and unlinking ----------

export type LinkRow = { id: string; peerOrigin: string; peerWorkspaceName: string | null; peerRole: string | null; createdAt: Date; lastUsedAt: Date | null; lastError: string | null };
const linkSelect = { id: true, peerOrigin: true, peerWorkspaceName: true, peerRole: true, createdAt: true, lastUsedAt: true, lastError: true } as const;

/** The signed-in person's own ACTIVE links in this workspace. Nobody else's, whatever their role. */
export async function listLinks(db: Db, v: Pick<Viewer, "workspaceId" | "userId">): Promise<LinkRow[]> {
  return db.federationLink.findMany({ where: { workspaceId: v.workspaceId, userId: v.userId, status: "ACTIVE" }, select: linkSelect, orderBy: { createdAt: "asc" }, take: 100 });
}

/** Administrators: every ACTIVE link of the workspace (who, to which instance, last used). No token, no data. */
export async function workspaceLinks(db: Db, v: Viewer): Promise<(LinkRow & { who: string })[]> {
  if (!can(v, "manageSpaces")) throw new ForbiddenError("Administrator only");
  const rows = await db.federationLink.findMany({ where: { workspaceId: v.workspaceId, status: "ACTIVE" }, select: { ...linkSelect, user: { select: { login: true, name: true, email: true } } }, orderBy: { createdAt: "asc" }, take: 500 });
  return rows.map(({ user, ...r }) => ({ ...r, who: user.name ?? user.email ?? `@${user.login}` }));
}

/** Ends a link: the token is deleted here, the peer is told (best effort), the cache goes. Own link, or any link for an administrator. */
export async function unlink(ctx: FedCtx, v: Viewer, linkId: string): Promise<void> {
  const { db, config } = ctx;
  const link = await db.federationLink.findFirst({ where: { id: linkId, workspaceId: v.workspaceId } });
  if (!link || (link.userId !== v.userId && !can(v, "manageSpaces"))) throw new NotFoundError();
  if (link.status === "REVOKED") return;
  const token = link.tokenEnc && config.key ? decryptSecret(link.tokenEnc, config.key, `token:${link.id}`) : null;
  // Delete first, tell the peer second: the link is gone here even if the peer cannot be reached.
  await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId }, data: { status: "REVOKED", tokenEnc: null, verifierEnc: null, stateHash: null, revokedAt: nowOf(ctx), lastError: null } });
  await db.federationCache.deleteMany({ where: { workspaceId: v.workspaceId, linkId: link.id } });
  await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "link.revoked", peerOrigin: link.peerOrigin, linkId: link.id, meta: { by: link.userId === v.userId ? "owner" : "admin" } });
  if (token) {
    try {
      await ctx.fetch(`${link.peerOrigin}${API}/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}", allowInsecure: config.allowInsecure });
    } catch {
      /* the peer is down or refuses: its token still expires, and its administrators can revoke it */
    }
  }
}

// ---------- reading the peer ----------

export type RemoteState = "ok" | "error" | "revoked" | "blocked";
export type Remote<T> = { state: RemoteState; data: T | null; fetchedAt: Date | null; /** Served from the cache past its TTL while a refresh runs. */ stale: boolean; error?: string };

const inflight = new Map<string, Promise<void>>();
/** Tests: wait for background refreshes started by `remoteGet(..., { background: true })`. */
export const settleRefreshes = () => Promise.all([...inflight.values()]).then(() => undefined);

/**
 * One GET to the peer for this person's link, through a cache. The policy is checked on EVERY call (before the cache is served, too),
 * so turning linking off or dropping an origin from the list hides what was cached at once. A fresh cache entry (under 60 s) is
 * served as is; an older one is served immediately and refreshed in the background when `background` is set (stale-while-revalidate),
 * otherwise refreshed first. A peer that is down returns the cached answer marked as such, or an error; a 401 is "access revoked".
 */
export async function remoteGet<T>(ctx: FedCtx, v: Viewer, linkId: string, path: string, opts: { background?: boolean; force?: boolean } = {}): Promise<Remote<T>> {
  const { db, config } = ctx;
  const now = nowOf(ctx);
  if (!/^\/[A-Za-z0-9_/?=&.-]{0,300}$/.test(path) || path.includes("..")) throw new ValidationError("Bad request.");
  const link = await db.federationLink.findFirst({ where: { id: linkId, workspaceId: v.workspaceId, userId: v.userId, status: "ACTIVE" } });
  if (!link) throw new NotFoundError();
  const policy = await loadPolicy(db, v.workspaceId);
  const decision = checkOrigin("outbound", link.peerOrigin, config, policy);
  if (!decision.ok) {
    // Once per ten minutes per link: a page polling every 30 s must not fill the audit trail.
    if (await take(db, `fed:blocked:${link.id}`, 1, 600_000, now)) await recordEvent(db, { workspaceId: v.workspaceId, userId: v.userId, kind: "policy.refused", peerOrigin: link.peerOrigin, linkId: link.id, meta: { reason: decision.reason, at: "read" } });
    return { state: "blocked", data: null, fetchedAt: null, stale: false, error: decision.reason };
  }
  const cached = await db.federationCache.findUnique({ where: { workspaceId_linkId_key: { workspaceId: v.workspaceId, linkId: link.id, key: path } } });
  let entry = cached && cached.userId === v.userId ? cached : null;
  if (entry && parsePeerBody(path, entry.bodyJson) === null) {
    // A cached body that no longer fits the shapes (an old version, or a row written before validation) is dropped, never rendered.
    await db.federationCache.deleteMany({ where: { workspaceId: v.workspaceId, linkId: link.id, key: path } });
    entry = null;
  }
  const age = entry ? now.getTime() - entry.fetchedAt.getTime() : Infinity;
  if (entry && age < CACHE_TTL_MS && !opts.force) return { state: "ok", data: entry.bodyJson as T, fetchedAt: entry.fetchedAt, stale: false };

  const refresh = () => refreshFromPeer<T>(ctx, v, link, path, entry);
  if (entry && opts.background && !opts.force) {
    const k = `${link.id}|${path}`;
    if (!inflight.has(k)) inflight.set(k, refresh().then(() => undefined, () => undefined).finally(() => void inflight.delete(k)));
    return { state: "ok", data: entry.bodyJson as T, fetchedAt: entry.fetchedAt, stale: true };
  }
  return refresh();
}

async function refreshFromPeer<T>(ctx: FedCtx, v: Viewer, link: { id: string; peerOrigin: string; tokenEnc: string | null }, path: string, entry: { etag: string | null; bodyJson: unknown; fetchedAt: Date } | null): Promise<Remote<T>> {
  const { db, config } = ctx;
  const now = nowOf(ctx);
  const fallback = (error: string, state: RemoteState = "error"): Remote<T> => ({ state, data: entry ? (entry.bodyJson as T) : null, fetchedAt: entry?.fetchedAt ?? null, stale: entry !== null, error });
  const token = link.tokenEnc && config.key ? decryptSecret(link.tokenEnc, config.key, `token:${link.id}`) : null;
  if (!token) return { state: "revoked", data: null, fetchedAt: null, stale: false, error: "This link can no longer be used. Unlink it and link again." };
  let res;
  try {
    res = await ctx.fetch(`${link.peerOrigin}${API}${path}`, { headers: { authorization: `Bearer ${token}`, ...(entry?.etag ? { "if-none-match": entry.etag } : {}) }, allowInsecure: config.allowInsecure });
  } catch (e) {
    const msg = peerMessage(e);
    await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId, userId: v.userId }, data: { lastError: msg } });
    return fallback(msg);
  }
  if (res.status === 401) {
    const msg = "The other instance no longer accepts this link: access was revoked, expired or switched off there.";
    await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId, userId: v.userId }, data: { lastError: msg } });
    await db.federationCache.deleteMany({ where: { workspaceId: v.workspaceId, linkId: link.id } }); // what was cached must not outlive the access
    return { state: "revoked", data: null, fetchedAt: null, stale: false, error: msg };
  }
  if (res.status === 304 && entry) {
    await db.federationCache.updateMany({ where: { workspaceId: v.workspaceId, linkId: link.id, userId: v.userId, key: path }, data: { fetchedAt: now } });
    await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId, userId: v.userId }, data: { lastUsedAt: now, lastError: null } });
    return { state: "ok", data: entry.bodyJson as T, fetchedAt: now, stale: false };
  }
  if (res.status === 404) {
    await db.federationCache.deleteMany({ where: { workspaceId: v.workspaceId, linkId: link.id, key: path } });
    return { state: "error", data: null, fetchedAt: null, stale: false, error: "That item is not available there (it may have been removed or is no longer shared with you)." };
  }
  if (res.status !== 200) {
    const msg = res.status === 429 ? "The other instance is rate limiting this link. It will retry." : "The other instance answered with an error.";
    return fallback(msg);
  }
  const etag = res.headers.etag ?? null;
  // Untrusted: validated against strict shapes BEFORE it is cached or rendered; unknown fields are dropped.
  const valid = parsePeerBody(path, res.json);
  if (valid === null) {
    const msg = "The other instance sent an answer this version cannot read.";
    await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId, userId: v.userId }, data: { lastError: msg } });
    return fallback(msg);
  }
  const body = valid as Prisma.InputJsonValue;
  await db.federationCache.upsert({
    where: { workspaceId_linkId_key: { workspaceId: v.workspaceId, linkId: link.id, key: path } },
    create: { workspaceId: v.workspaceId, userId: v.userId, linkId: link.id, key: path, etag, bodyJson: body, fetchedAt: now },
    update: { etag, bodyJson: body, fetchedAt: now },
  });
  await db.federationLink.updateMany({ where: { id: link.id, workspaceId: v.workspaceId, userId: v.userId }, data: { lastUsedAt: now, lastError: null } });
  return { state: "ok", data: body as T, fetchedAt: now, stale: false };
}
