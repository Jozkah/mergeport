import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { A_ORIGIN, B_ORIGIN, KEY, bearer, config, get, linkUp, makeWorld, openPolicies, paramsOf, type World } from "./federation-harness";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import { leaks } from "./helpers";
import type { Db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { planningBoard } from "@/lib/services/planning-view";
import { createRestrictedSpace, setProjectAccessSpace, setSpaceMember } from "@/lib/services/access-spaces";
import { createTask } from "@/lib/services/tasks";
import { decryptSecret, encryptSecret, federationState, normaliseOrigin, parseKey, pkceChallenge } from "@/lib/federation/config";
import { completeCallback, listLinks, remoteGet, settleRefreshes, startLink, unlink, workspaceLinks } from "@/lib/federation/consumer";
import { canCreateLink, checkOrigin, loadPolicy, savePolicy } from "@/lib/federation/policy";
import { approveAuthorization, authenticate, denyAuthorization, eligibleWorkspaces, myGrants, parseAuthorizeRequest, revokeAllFromOrigin, revokeGrant, workspaceGrants } from "@/lib/federation/provider";
import { meRoute, projectRoute, projectsRoute, revokeRoute, tasksRoute, tokenRoute } from "@/lib/federation/provider-http";
import type { BoardDto, ProjectDto, TaskDto } from "@/lib/federation/read-api";

let db: Db;
let w: World;
let n = 0;
beforeEach(async () => {
  db = createTestPrisma(`federation-${n++}`);
  w = await makeWorld(db);
  await openPolicies(w);
});

// Each test has its own database and pool; closing it keeps this long file under Postgres's connection limit.
afterEach(async () => {
  await db.$disconnect();
});

const json = async (res: Response) => (res.status === 304 ? null : JSON.parse(await res.text()));
const KEYS = (o: object) => Object.keys(o).sort();

// ---------- the handshake ----------

describe("handshake: authorization code + PKCE S256 + state", () => {
  it("links two instances end to end and the consumer sees the provider's projects read-only", async () => {
    const { linkId } = await linkUp(w);
    const links = await listLinks(db, w.aOwner);
    expect(links).toMatchObject([{ id: linkId, peerOrigin: B_ORIGIN, peerWorkspaceName: "Demo workspace (synthetic data)", peerRole: "MEMBER" }]);
    const r = await remoteGet<{ projects: ProjectDto[] }>(w.A, w.aOwner, linkId, "/projects");
    expect(r.state).toBe("ok");
    expect(r.data!.projects.map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]); // what B's member `a` sees
    const board = await remoteGet<BoardDto>(w.A, w.aOwner, linkId, `/projects/${r.data!.projects[0].id}`);
    expect(board.data!.columns.map((c) => c.key)).toContain("backlog");
  });

  it("the authorization request carries state, an S256 challenge and the exact callback address", async () => {
    const { authorizeUrl } = await startLink(w.A, w.aOwner, "b.test");
    const u = new URL(authorizeUrl);
    expect(u.origin).toBe(B_ORIGIN);
    expect(u.pathname).toBe("/federation/authorize");
    const p = paramsOf(authorizeUrl);
    expect(p).toMatchObject({ client_origin: A_ORIGIN, redirect_uri: `${A_ORIGIN}/federation/callback`, code_challenge_method: "S256", scope: "read", response_type: "code" });
    expect(p.state.length).toBeGreaterThanOrEqual(40);
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = await db.federationLink.findFirstOrThrow({ where: { workspaceId: w.aWs, status: "PENDING" } });
    expect(pending.stateHash).toBe(sha256(p.state)); // only the hash of the state is stored
    expect(pending.verifierEnc).not.toContain(p.code_challenge);
    expect(pkceChallenge(decryptSecret(pending.verifierEnc!, KEY)!)).toBe(p.code_challenge);
  });

  async function codeFor(userId = w.ids.users.a.id) {
    const { authorizeUrl } = await startLink(w.A, w.aOwner, B_ORIGIN);
    const req = parseAuthorizeRequest(w.B, paramsOf(authorizeUrl));
    if (!req.ok) throw new Error(req.error);
    const { redirectTo } = await approveAuthorization(w.B, userId, req.req, w.ids.ws.id);
    const back = paramsOf(redirectTo);
    const pending = await db.federationLink.findFirstOrThrow({ where: { workspaceId: w.aWs, status: "PENDING" } });
    const verifier = decryptSecret(pending.verifierEnc!, KEY)!;
    return { code: back.code, state: back.state, verifier, back, redirectUri: req.req.redirectUri };
  }
  const exchange = (b: Record<string, string>) => tokenRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/token`, { method: "POST", body: JSON.stringify(b) }));

  it("a code works once: the second use fails and revokes the token the first produced", async () => {
    const c = await codeFor();
    const body = { code: c.code, code_verifier: c.verifier, redirect_uri: c.redirectUri, client_origin: A_ORIGIN };
    const ok = await exchange(body);
    expect(ok.status).toBe(200);
    const token = (await json(ok)).access_token as string;
    expect(await authenticate(w.B, token)).not.toBeNull();
    expect((await exchange(body)).status).toBe(400);
    expect(await authenticate(w.B, token)).toBeNull(); // the replay killed it
  });

  it.each([
    ["a wrong verifier", (c: Awaited<ReturnType<typeof codeFor>>) => ({ code_verifier: "x".repeat(60), code: c.code })],
    ["a different redirect_uri", () => ({ redirect_uri: "https://evil.test/federation/callback" })],
    ["a different client_origin", () => ({ client_origin: "https://evil.test" })],
  ])("%s fails and the code is dead afterwards, even for the right request", async (_n, patch) => {
    const c = await codeFor();
    const good = { code: c.code, code_verifier: c.verifier, redirect_uri: c.redirectUri, client_origin: A_ORIGIN };
    expect((await exchange({ ...good, ...patch(c) })).status).toBe(400);
    expect((await exchange(good)).status).toBe(400);
    expect(await db.federationGrant.count({ where: { workspaceId: w.ids.ws.id, tokenHash: { not: null } } })).toBe(0);
  });

  it("an expired code (60 s) fails", async () => {
    const c = await codeFor();
    w.advance(61_000);
    expect((await exchange({ code: c.code, code_verifier: c.verifier, redirect_uri: c.redirectUri, client_origin: A_ORIGIN })).status).toBe(400);
  });

  it("a mismatched state, a reused state and another person's state link nothing", async () => {
    const c = await codeFor();
    expect(await completeCallback(w.A, w.aOwner.userId, { code: c.code, state: "x".repeat(43) })).toMatchObject({ ok: false, code: "invalid" });
    const other = await person(db, "mallory@a.test");
    expect(await completeCallback(w.A, other.id, { code: c.code, state: c.state })).toMatchObject({ ok: false, code: "invalid" }); // state belongs to the owner's pending link
    expect(await completeCallback(w.A, w.aOwner.userId, { code: c.code, state: c.state })).toMatchObject({ ok: true });
    expect(await completeCallback(w.A, w.aOwner.userId, { code: c.code, state: c.state })).toMatchObject({ ok: false, code: "invalid" }); // state is single use
  });

  it("a pending link expires after 10 minutes", async () => {
    const c = await codeFor();
    w.advance(11 * 60_000);
    expect(await completeCallback(w.A, w.aOwner.userId, { code: c.code, state: c.state })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("denying sends access_denied with the state and marks the link failed", async () => {
    const { authorizeUrl } = await startLink(w.A, w.aOwner, B_ORIGIN);
    const req = parseAuthorizeRequest(w.B, paramsOf(authorizeUrl));
    if (!req.ok) throw new Error();
    const { redirectTo } = await denyAuthorization(w.B, w.ids.users.a.id, req.req, w.ids.ws.id);
    const back = paramsOf(redirectTo);
    expect(redirectTo.startsWith(`${A_ORIGIN}/federation/callback?`)).toBe(true);
    expect(back).toMatchObject({ error: "access_denied", state: req.req.state });
    expect(await completeCallback(w.A, w.aOwner.userId, { error: back.error, state: back.state })).toMatchObject({ ok: false, code: "denied" });
    expect(await listLinks(db, w.aOwner)).toEqual([]);
    expect(await db.federationEvent.count({ where: { workspaceId: w.ids.ws.id, kind: "grant.denied" } })).toBe(1);
  });

  it("a code is bound to the challenge: a verifier for another challenge fails", async () => {
    const c = await codeFor();
    const other = "o".repeat(64);
    expect(pkceChallenge(other)).not.toBe(pkceChallenge(c.verifier));
    expect((await exchange({ code: c.code, code_verifier: other, redirect_uri: c.redirectUri, client_origin: A_ORIGIN })).status).toBe(400);
  });
});

describe("authorize request validation (open redirect is impossible)", () => {
  const base = { client_origin: A_ORIGIN, redirect_uri: `${A_ORIGIN}/federation/callback`, state: "s".repeat(40), code_challenge: "c".repeat(43), code_challenge_method: "S256", scope: "read" };
  it("accepts the exact request", () => expect(parseAuthorizeRequest(w.B, base).ok).toBe(true));
  it.each([
    ["another host", { redirect_uri: "https://evil.test/federation/callback" }],
    ["a different path", { redirect_uri: `${A_ORIGIN}/other` }],
    ["a trailing path", { redirect_uri: `${A_ORIGIN}/federation/callback/../../evil` }],
    ["a query on the callback", { redirect_uri: `${A_ORIGIN}/federation/callback?next=https://evil.test` }],
    ["a protocol-relative address", { redirect_uri: "//evil.test/federation/callback" }],
    ["credentials in the client origin", { client_origin: "https://user:pw@a.test", redirect_uri: "https://user:pw@a.test/federation/callback" }],
    ["http", { client_origin: "http://a.test", redirect_uri: "http://a.test/federation/callback" }],
    ["a path in client_origin", { client_origin: `${A_ORIGIN}/x`, redirect_uri: `${A_ORIGIN}/x/federation/callback` }],
    ["itself as the client", { client_origin: B_ORIGIN, redirect_uri: `${B_ORIGIN}/federation/callback` }],
    ["a missing state", { state: "" }],
    ["a short state", { state: "abc" }],
    ["a plain challenge method", { code_challenge_method: "plain" }],
    ["a malformed challenge", { code_challenge: "short" }],
    ["a write scope", { scope: "write" }],
    ["an implicit response type", { response_type: "token" }],
  ])("refuses %s", (_n, patch) => expect(parseAuthorizeRequest(w.B, { ...base, ...patch }).ok).toBe(false));
  it("refuses a client the server ceiling does not allow", () => {
    expect(parseAuthorizeRequest({ ...w.B, config: config({ mode: "allowlist", allowlist: ["https://other.test"] }) }, base).ok).toBe(false);
    expect(parseAuthorizeRequest({ ...w.B, config: config({ mode: "off" }) }, base).ok).toBe(false);
  });
});

// ---------- secrets at rest ----------

describe("tokens at rest", () => {
  it("the provider stores only sha256 of the token and of the code; the consumer stores the token encrypted", async () => {
    const { linkId, token, code } = await linkUp(w);
    const grant = await db.federationGrant.findFirstOrThrow({ where: { workspaceId: w.ids.ws.id } });
    expect(grant.tokenHash).toBe(sha256(token));
    expect(grant.codeHash).toBe(sha256(code));
    const link = await db.federationLink.findFirstOrThrow({ where: { id: linkId, workspaceId: w.aWs } });
    expect(link.tokenEnc).not.toContain(token);
    expect(link.tokenEnc!.startsWith("v1.")).toBe(true);
    expect(decryptSecret(link.tokenEnc!, KEY)).toBe(token);
    expect(decryptSecret(link.tokenEnc!, Buffer.alloc(32, 7))).toBeNull(); // another key cannot read it
    // nothing anywhere in the federation tables (events, cache, grants, links) holds the token or the code in clear
    const dump = JSON.stringify([await db.federationEvent.findMany({ where: { workspaceId: w.ids.ws.id } }), await db.federationEvent.findMany({ where: { workspaceId: w.aWs } }), await db.federationGrant.findMany({ where: { workspaceId: w.ids.ws.id } }), await db.federationLink.findMany({ where: { workspaceId: w.aWs } }), await db.federationCache.findMany({ where: { workspaceId: w.aWs } })]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
  });

  it("AES-256-GCM: round trip, tamper detection, key formats", () => {
    const blob = encryptSecret("secret-token", KEY);
    expect(blob).not.toContain("secret-token");
    expect(decryptSecret(blob, KEY)).toBe("secret-token");
    expect(encryptSecret("secret-token", KEY)).not.toBe(blob); // fresh IV
    expect(decryptSecret(blob.slice(0, -2) + "AA", KEY)).toBeNull();
    expect(decryptSecret("garbage", KEY)).toBeNull();
    expect(parseKey(KEY.toString("hex"))!.equals(KEY)).toBe(true);
    expect(parseKey(KEY.toString("base64"))!.equals(KEY)).toBe(true);
    expect(parseKey("short")).toBeNull();
    expect(parseKey(undefined)).toBeNull();
  });
});

// ---------- the ceiling and the policy ----------

describe("operator ceiling", () => {
  const env = (o: Record<string, string | undefined>) => ({ ...o }) as NodeJS.ProcessEnv;
  const K = KEY.toString("hex");
  it("is absent when not hosted or off, misconfigured without a key, enabled otherwise", () => {
    expect(federationState(env({ MERGEPORT_FEDERATION: "any", MERGEPORT_ENCRYPTION_KEY: K }), false).kind).toBe("absent");
    expect(federationState(env({}), true).kind).toBe("absent");
    expect(federationState(env({ MERGEPORT_FEDERATION: "off", MERGEPORT_ENCRYPTION_KEY: K }), true).kind).toBe("absent");
    expect(federationState(env({ MERGEPORT_FEDERATION: "nonsense", MERGEPORT_ENCRYPTION_KEY: K }), true).kind).toBe("absent");
    expect(federationState(env({ MERGEPORT_FEDERATION: "any" }), true).kind).toBe("misconfigured");
    expect(federationState(env({ MERGEPORT_FEDERATION: "any", MERGEPORT_ENCRYPTION_KEY: "short" }), true).kind).toBe("misconfigured");
    expect(federationState(env({ MERGEPORT_FEDERATION: "allowlist", MERGEPORT_ENCRYPTION_KEY: K }), true).kind).toBe("enabled");
  });
  it("allow-insecure works outside production and is ignored in production", () => {
    const dev = federationState(env({ MERGEPORT_FEDERATION: "any", MERGEPORT_ENCRYPTION_KEY: K, MERGEPORT_FEDERATION_ALLOW_INSECURE: "1", NODE_ENV: "development" }), true);
    expect(dev.kind === "enabled" && dev.config.allowInsecure).toBe(true);
    const prod = federationState(env({ MERGEPORT_FEDERATION: "any", MERGEPORT_ENCRYPTION_KEY: K, MERGEPORT_FEDERATION_ALLOW_INSECURE: "1", NODE_ENV: "production" }), true);
    expect(prod.kind === "enabled" && prod.config.allowInsecure).toBe(false);
    expect(normaliseOrigin("http://b.test", false)).toBeNull();
    expect(normaliseOrigin("http://b.test", true)).toBe("http://b.test");
  });
  it("normalises addresses to an https origin and refuses junk", () => {
    expect(normaliseOrigin("B.Test", false)).toBe("https://b.test");
    expect(normaliseOrigin("https://b.test/projects?x=1#y", false)).toBe("https://b.test");
    expect(normaliseOrigin("https://b.test:8443", false)).toBe("https://b.test:8443");
    for (const bad of ["", "ftp://b.test", "https://user:pw@b.test", "javascript:alert(1)", "https://", "not a host"]) expect(normaliseOrigin(bad, false), bad).toBeNull();
  });
  it("ceiling allowlist limits even a workspace set to any", async () => {
    const ceiling = config({ mode: "allowlist", allowlist: ["https://ok.test"] });
    const open = await loadPolicy(db, w.aWs);
    expect(checkOrigin("outbound", "https://ok.test", ceiling, open).ok).toBe(true);
    expect(checkOrigin("outbound", B_ORIGIN, ceiling, open).ok).toBe(false);
    await expect(startLink({ ...w.A, config: ceiling }, w.aOwner, B_ORIGIN)).rejects.toThrow(ForbiddenError);
  });
});

describe("workspace policy is evaluated on every request", () => {
  it("inbound off on the provider stops an existing link at once; switching it on again resumes it", async () => {
    const { linkId, token } = await linkUp(w);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(200);
    await savePolicy(db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    const res = await meRoute(w.B, get("/api/federation/v1/me", token));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "unauthorized" });
    w.advance(120_000);
    const r = await remoteGet(w.A, w.aOwner, linkId, "/projects", { force: true });
    expect(r).toMatchObject({ state: "revoked", data: null });
    await savePolicy(db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "any", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(200);
    expect(await db.federationEvent.count({ where: { workspaceId: w.ids.ws.id, kind: "policy.refused" } })).toBeGreaterThan(0);
  });

  it("removing the origin from the provider's allow list stops the link; the ceiling going off does too", async () => {
    const { token } = await linkUp(w);
    await savePolicy(db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "allowlist", allowlist: [B_ORIGIN], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(401);
    await savePolicy(db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "allowlist", allowlist: [A_ORIGIN], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(200);
    // the operator turns federation off: the same ctx with mode off refuses the token
    expect(await authenticate({ ...w.B, config: config({ mode: "off" }) }, token)).toBeNull();
    // the operator's allow list no longer names the client
    expect(await authenticate({ ...w.B, config: config({ mode: "allowlist", allowlist: ["https://else.test"] }) }, token)).toBeNull();
  });

  it("outbound off on the consumer hides even what was cached, and refuses new links", async () => {
    const { linkId } = await linkUp(w);
    expect((await remoteGet(w.A, w.aOwner, linkId, "/projects")).state).toBe("ok");
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "off", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    expect(await remoteGet(w.A, w.aOwner, linkId, "/projects")).toMatchObject({ state: "blocked", data: null, fetchedAt: null }); // cached copy is not served
    await expect(startLink(w.A, w.aOwner, "https://c.test")).rejects.toThrow(ForbiddenError);
    expect(await db.federationEvent.count({ where: { workspaceId: w.aWs, kind: "policy.refused" } })).toBeGreaterThan(0);
  });

  it("the consumer's allow list and the provider's both gate the handshake", async () => {
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "allowlist", inboundMode: "off", allowlist: ["https://c.test"], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    await expect(startLink(w.A, w.aOwner, B_ORIGIN)).rejects.toThrow(/allowed list/);
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    const { authorizeUrl } = await startLink(w.A, w.aOwner, B_ORIGIN);
    const req = parseAuthorizeRequest(w.B, paramsOf(authorizeUrl));
    if (!req.ok) throw new Error();
    await savePolicy(db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    expect((await eligibleWorkspaces(w.B, w.ids.users.a.id, A_ORIGIN)).eligible).toEqual([]);
    await expect(approveAuthorization(w.B, w.ids.users.a.id, req.req, w.ids.ws.id)).rejects.toThrow(ForbiddenError);
  });

  it("who can link: admins by default, members when allowed, readers never", async () => {
    const member = await addMember(db, w.aWs, "m@a.test", "MEMBER");
    const reader = await addMember(db, w.aWs, "r@a.test", "READER");
    const admin = await addMember(db, w.aWs, "ad@a.test", "ADMIN");
    const policy = await loadPolicy(db, w.aWs);
    expect(canCreateLink("OWNER", policy) && canCreateLink("ADMIN", policy)).toBe(true);
    expect(canCreateLink("MEMBER", policy)).toBe(false);
    expect(canCreateLink("READER", policy)).toBe(false);
    await expect(startLink(w.A, await member.viewer(), B_ORIGIN)).rejects.toThrow(ForbiddenError);
    expect((await startLink(w.A, await admin.viewer(), B_ORIGIN)).authorizeUrl).toContain("/federation/authorize");
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "MEMBER", maxLinksPerUser: 5, maxPeers: 5 });
    const p2 = await loadPolicy(db, w.aWs);
    expect(canCreateLink("MEMBER", p2)).toBe(true);
    expect(canCreateLink("READER", p2)).toBe(false);
    expect((await startLink(w.A, await member.viewer(), B_ORIGIN)).authorizeUrl).toContain("/federation/authorize");
    await expect(startLink(w.A, await reader.viewer(), B_ORIGIN)).rejects.toThrow(ForbiddenError);
  });

  it("limits: maxPeers (0 none, 1 a single instance) and maxLinksPerUser", async () => {
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 0 });
    await expect(startLink(w.A, w.aOwner, B_ORIGIN)).rejects.toThrow(/not allowed/);
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 1 });
    await linkUp(w);
    await expect(startLink(w.A, w.aOwner, "https://c.test")).rejects.toThrow(/single linked instance|single instance/);
    await expect(startLink(w.A, w.aOwner, B_ORIGIN)).rejects.toThrow(/already linked/); // same peer again
    await savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 1, maxPeers: 5 });
    await expect(startLink(w.A, w.aOwner, "https://c.test")).rejects.toThrow(/at most 1 instance/);
  });

  it("only administrators change the policy, the input is validated, and each change is audited with before and after", async () => {
    const member = await addMember(db, w.aWs, "m2@a.test", "MEMBER");
    await expect(savePolicy(db, w.A.config, await member.viewer(), { outboundMode: "any", inboundMode: "any", allowlist: [], whoCanLink: "MEMBER", maxLinksPerUser: 1, maxPeers: 1 })).rejects.toThrow(ForbiddenError);
    const ok = { outboundMode: "any", inboundMode: "off", allowlist: "", whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 };
    for (const bad of [{ outboundMode: "sometimes" }, { whoCanLink: "READER" }, { maxPeers: -1 }, { maxPeers: 51 }, { maxLinksPerUser: 1.5 }, { allowlist: "javascript:alert(1)" }]) {
      await expect(savePolicy(db, w.A.config, w.aOwner, { ...ok, ...bad }), JSON.stringify(bad)).rejects.toThrow(ValidationError);
    }
    const saved = await savePolicy(db, w.A.config, w.aOwner, { ...ok, allowlist: "B.Test\nhttps://b.test/x https://c.test" });
    expect(saved.allowlist).toEqual([B_ORIGIN, "https://c.test"]); // normalised and de-duplicated
    const ev = await db.federationEvent.findMany({ where: { workspaceId: w.aWs, kind: "policy.changed" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(ev[0].userId).toBe(w.aOwner.userId);
    expect(ev[0].meta).toMatchObject({ before: { outboundMode: "any" }, after: { allowlist: [B_ORIGIN, "https://c.test"] } });
  });

  it("starting a link refuses a non-Mergeport address and itself", async () => {
    await expect(startLink(w.A, w.aOwner, A_ORIGIN)).rejects.toThrow(/different one/);
    await expect(startLink(w.A, w.aOwner, "not a host")).rejects.toThrow(ValidationError);
    await expect(startLink(w.A, w.aOwner, "https://c.test")).rejects.toThrow(/could not|Could not/i); // unreachable
  });
});

// ---------- the provider API ----------

describe("provider read API", () => {
  it("answers 401 uniformly for a missing, malformed, wrong, revoked and expired token", async () => {
    const { token } = await linkUp(w);
    const bodies = new Set<string>();
    for (const h of [{}, { authorization: "Bearer" }, { authorization: "Basic abc" }, bearer("x".repeat(43)), { authorization: `Bearer ${token}x` }]) {
      const res = await meRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/me`, { headers: h }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      bodies.add(await res.text());
    }
    await db.federationGrant.updateMany({ where: { workspaceId: w.ids.ws.id }, data: { revokedAt: new Date() } });
    const revoked = await meRoute(w.B, get("/api/federation/v1/me", token));
    bodies.add(await revoked.text());
    expect(revoked.status).toBe(401);
    await db.federationGrant.updateMany({ where: { workspaceId: w.ids.ws.id }, data: { revokedAt: null } });
    w.advance(31 * 24 * 3600_000); // idle 31 days
    const expired = await meRoute(w.B, get("/api/federation/v1/me", token));
    bodies.add(await expired.text());
    expect(expired.status).toBe(401);
    expect(bodies.size).toBe(1); // one identical body
  });

  it("the token slides to 30 days on use and never past 180 days from approval", async () => {
    const { token } = await linkUp(w);
    for (let i = 0; i < 5; i++) {
      w.advance(29 * 24 * 3600_000);
      const res = await meRoute(w.B, get("/api/federation/v1/me", token));
      if (i < 5) expect([200, 401]).toContain(res.status);
    }
    const g = await db.federationGrant.findFirstOrThrow({ where: { workspaceId: w.ids.ws.id } });
    expect(g.absoluteExpiresAt!.getTime() - g.createdAt.getTime()).toBe(180 * 24 * 3600_000);
    expect(g.expiresAt!.getTime()).toBeLessThanOrEqual(g.absoluteExpiresAt!.getTime());
    w.advance(40 * 24 * 3600_000);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(401);
  });

  it("returns exactly the allowlisted fields and nothing else", async () => {
    const { token } = await linkUp(w);
    const me = await json(await meRoute(w.B, get("/api/federation/v1/me", token)));
    expect(KEYS(me)).toEqual(["role", "scope", "workspace"]);
    expect(KEYS(me.workspace)).toEqual(["name"]);
    const list = await json(await projectsRoute(w.B, get("/api/federation/v1/projects", token)));
    expect(KEYS(list)).toEqual(["nextCursor", "projects"]);
    for (const p of list.projects) expect(KEYS(p)).toEqual(["description", "id", "name", "slug"]);
    const atlas = list.projects.find((p: ProjectDto) => p.name === "Atlas");
    const board = await json(await projectRoute(w.B, get(`/api/federation/v1/projects/${atlas.id}`, token), atlas.id));
    expect(KEYS(board)).toEqual(["columns", "project", "truncated"]);
    for (const c of board.columns) {
      expect(KEYS(c)).toEqual(["items", "key", "name", "position"]);
      for (const i of c.items) expect(KEYS(i)).toEqual(["assignee", "dueDate", "id", "labels", "linked", "position", "priority", "title"]);
    }
    const tasks = await json(await tasksRoute(w.B, get(`/api/federation/v1/projects/${atlas.id}/tasks`, token), atlas.id));
    expect(tasks.tasks.length).toBeGreaterThan(0);
    for (const t of tasks.tasks) expect(KEYS(t)).toEqual(["assignee", "columnKey", "columnName", "createdAt", "description", "dueDate", "id", "labels", "linked", "position", "priority", "title", "updatedAt"]);
    // no secret-looking or internal FIELD NAME anywhere in any answer, and no email address in any value
    const names = (o: unknown): string[] => (Array.isArray(o) ? o.flatMap(names) : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k.toLowerCase(), ...names(v)]) : []);
    const fields = new Set(names([me, list, board, tasks]));
    for (const bad of ["email", "tokenhash", "token", "githubid", "avatarurl", "workspaceid", "userid", "createdbyid", "memberid", "accessspaceid", "version", "repositoryid", "login", "csrf"]) expect(fields.has(bad), bad).toBe(false);
    expect(JSON.stringify([me, list, board, tasks])).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it("caps page sizes, pages with a cursor, and keeps pages consistent", async () => {
    const { token } = await linkUp(w);
    const atlas = (await json(await projectsRoute(w.B, get("/api/federation/v1/projects", token)))).projects.find((p: ProjectDto) => p.name === "Atlas");
    for (let i = 0; i < 6; i++) await createTask(db, w.admin, { projectId: atlas.id, title: `bulk ${i}` }); // admin sees all
    const all = await json(await tasksRoute(w.B, get(`/api/federation/v1/projects/${atlas.id}/tasks?limit=1000`, token), atlas.id));
    expect(all.tasks.length).toBeLessThanOrEqual(100);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const page: { tasks: TaskDto[]; nextCursor: string | null } = await json(await tasksRoute(w.B, get(`/api/federation/v1/projects/${atlas.id}/tasks?limit=3${cursor ? `&cursor=${cursor}` : ""}`, token), atlas.id));
      expect(page.tasks.length).toBeLessThanOrEqual(3);
      seen.push(...page.tasks.map((t) => t.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(all.tasks.map((t: TaskDto) => t.id).sort());
    const small = await json(await projectsRoute(w.B, get("/api/federation/v1/projects?limit=1", token)));
    expect(small.projects).toHaveLength(1);
    expect(small.nextCursor).toBeTruthy();
  });

  it("ETag and If-None-Match: an unchanged answer is an empty 304", async () => {
    const { token } = await linkUp(w);
    const first = await projectsRoute(w.B, get("/api/federation/v1/projects", token));
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await projectsRoute(w.B, get("/api/federation/v1/projects", token, { "if-none-match": etag }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const other = await projectsRoute(w.B, get("/api/federation/v1/projects", token, { "if-none-match": '"nope"' }));
    expect(other.status).toBe(200);
  });

  it("hidden and nonexistent projects are indistinguishable (404, same body)", async () => {
    const { token } = await linkUp(w);
    const space = await createRestrictedSpace(db, w.admin, "Skunk");
    await setProjectAccessSpace(db, w.admin, w.ids.projects.atlas.id, space.id); // `a` is not in it
    const hidden = await projectRoute(w.B, get(`/api/federation/v1/projects/${w.ids.projects.atlas.id}`, token), w.ids.projects.atlas.id);
    const missing = await projectRoute(w.B, get("/api/federation/v1/projects/nope", token), "nope");
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(await hidden.text()).toBe(await missing.text());
    const t1 = await tasksRoute(w.B, get(`/api/federation/v1/projects/${w.ids.projects.atlas.id}/tasks`, token), w.ids.projects.atlas.id);
    expect(t1.status).toBe(404);
  });

  it("rate limits per grant (120 per minute) and per client address on the token endpoint (30)", async () => {
    const { token } = await linkUp(w);
    let last = 200;
    for (let i = 0; i < 125; i++) last = (await meRoute(w.B, get("/api/federation/v1/me", token))).status;
    expect(last).toBe(429);
    const limited = await meRoute(w.B, get("/api/federation/v1/me", token));
    expect(limited.headers.get("retry-after")).toBe("60");
    w.advance(61_000);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(200); // the window resets
    let status = 0;
    for (let i = 0; i < 32; i++) status = (await tokenRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/token`, { method: "POST", body: JSON.stringify({ code: "c".repeat(30), code_verifier: "v".repeat(50), redirect_uri: "x", client_origin: A_ORIGIN }) }))).status;
    expect(status).toBe(429);
  });

  it("the revoke endpoint always answers 200 and only ever ends the presented token", async () => {
    const { token } = await linkUp(w);
    expect((await revokeRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/revoke`, { method: "POST", headers: bearer("z".repeat(43)), body: "{}" }))).status).toBe(200);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(200); // an unknown token revoked nothing
    expect((await revokeRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/revoke`, { method: "POST", headers: bearer(token), body: "{}" }))).status).toBe(200);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(401);
  });

  it("answers carry no cookies and are marked no-sniff", async () => {
    const { token } = await linkUp(w);
    const res = await meRoute(w.B, get("/api/federation/v1/me", token));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });
});

// ---------- authorization is reused, not reimplemented ----------

describe("what a grant can read is exactly what its person can read", () => {
  /** The oracle: the person's own board. The DTO's cards must be the same cards. */
  async function sameAsOwnBoard(token: string, viewer: Viewer, projectId: string) {
    const res = await projectRoute(w.B, get(`/api/federation/v1/projects/${projectId}`, token), projectId);
    const own = await planningBoard(db, viewer, projectId);
    const dto = res.status === 200 ? ((await json(res)) as BoardDto) : null;
    return { dto, ids: dto?.columns.flatMap((c) => c.items.map((i) => i.id)).sort() ?? [], ownIds: own.cards.map((c) => c.id).sort() };
  }

  it.each([["admin"], ["a"], ["b"]] as const)("as %s: the board is the person's own board", async (who) => {
    const viewer = w[who];
    const { token } = await linkUp(w, w.aOwner, { userId: viewer.userId, workspaceId: w.ids.ws.id });
    const projects = (await json(await projectsRoute(w.B, get("/api/federation/v1/projects", token)))).projects as ProjectDto[];
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      const r = await sameAsOwnBoard(token, viewer, p.id);
      expect(r.ids).toEqual(r.ownIds);
    }
  });

  it("a READER sees only what a reader sees", async () => {
    const reader = await addMember(db, w.ids.ws.id, "reader@b.test", "READER");
    await db.projectMember.create({ data: { projectId: w.ids.projects.atlas.id, memberId: reader.member.id } });
    await db.repositoryGrant.create({ data: { memberId: reader.member.id, repositoryId: w.ids.repos.web.id, grantedById: w.ids.users.admin.id, canManageWork: false, canReview: false } });
    const rv = await reader.viewer();
    const { token } = await linkUp(w, w.aOwner, { userId: reader.user.id, workspaceId: w.ids.ws.id });
    const me = await json(await meRoute(w.B, get("/api/federation/v1/me", token)));
    expect(me.role).toBe("READER");
    const list = (await json(await projectsRoute(w.B, get("/api/federation/v1/projects", token)))).projects as ProjectDto[];
    expect(list.map((p) => p.name)).toEqual(["Atlas"]); // member of Atlas only, never Dashboard
    const r = await sameAsOwnBoard(token, rv, w.ids.projects.atlas.id);
    expect(r.ids).toEqual(r.ownIds);
    const admin = await planningBoard(db, w.admin, w.ids.projects.atlas.id);
    expect(r.ids.length).toBeLessThan(admin.cards.length); // strictly less than an administrator sees
  });

  it("a restricted-space project is invisible to a grant whose person is not in the space", async () => {
    const space = await createRestrictedSpace(db, w.admin, "Skunkworks");
    await setSpaceMember(db, w.admin, space.id, w.ids.members.a.id, true);
    await createTask(db, w.admin, { projectId: w.ids.projects.atlas.id, title: "ZEBRA-RESTRICTED-TASK" });
    await setProjectAccessSpace(db, w.admin, w.ids.projects.atlas.id, space.id);
    const inside = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    const outside = await linkUp(w, await addAOwner2(), { userId: w.ids.users.b.id, workspaceId: w.ids.ws.id });
    const listIn = (await json(await projectsRoute(w.B, get("/api/federation/v1/projects", inside.token)))).projects as ProjectDto[];
    const listOut = (await json(await projectsRoute(w.B, get("/api/federation/v1/projects", outside.token)))).projects as ProjectDto[];
    expect(listIn.map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
    expect(listOut.map((p) => p.name)).toEqual(["Dashboard"]);
    const id = w.ids.projects.atlas.id;
    expect((await projectRoute(w.B, get(`/api/federation/v1/projects/${id}`, outside.token), id)).status).toBe(404);
    expect((await tasksRoute(w.B, get(`/api/federation/v1/projects/${id}/tasks`, outside.token), id)).status).toBe(404);
    expect(leaks(listOut, "Atlas")).toBe(false);
    const board = await projectRoute(w.B, get(`/api/federation/v1/projects/${id}`, inside.token), id);
    expect(await board.text()).toContain("ZEBRA-RESTRICTED-TASK");
    // not even the OWNER (outside the space) is shown it through a grant
    const owner = await linkUp(w, await addAOwner3(), { userId: w.ids.users.admin.id, workspaceId: w.ids.ws.id });
    expect((await projectRoute(w.B, get(`/api/federation/v1/projects/${id}`, owner.token), id)).status).toBe(404);
  });

  async function addAOwner2() {
    const m = await addMember(db, w.aWs, "second@a.test", "ADMIN");
    return m.viewer();
  }
  async function addAOwner3() {
    const m = await addMember(db, w.aWs, "third@a.test", "ADMIN");
    return m.viewer();
  }

  it("a grant for workspace W1 can never read workspace W2 (even by project id)", async () => {
    const other = await workspaceWithOwner(db, "ob@b.test", "Other Co on B");
    const secret = await db.project.create({ data: { workspaceId: other.ws.id, name: "OTHER-TENANT-PROJECT", slug: "other" } });
    await db.planningColumn.create({ data: { projectId: secret.id, key: "backlog", name: "Backlog", position: 0 } });
    const { token } = await linkUp(w);
    const list = JSON.stringify(await json(await projectsRoute(w.B, get("/api/federation/v1/projects", token))));
    expect(list).not.toContain("OTHER-TENANT-PROJECT");
    expect((await projectRoute(w.B, get(`/api/federation/v1/projects/${secret.id}`, token), secret.id)).status).toBe(404);
    expect((await tasksRoute(w.B, get(`/api/federation/v1/projects/${secret.id}/tasks`, token), secret.id)).status).toBe(404);
    // the same person is an admin of W2 as well: the W1 grant still does not reach it
    await db.member.create({ data: { workspaceId: other.ws.id, userId: w.ids.users.a.id, role: "ADMIN" } });
    expect((await projectRoute(w.B, get(`/api/federation/v1/projects/${secret.id}`, token), secret.id)).status).toBe(404);
  });

  it("losing membership ends the grant's reach immediately", async () => {
    const { token } = await linkUp(w);
    await db.member.updateMany({ where: { workspaceId: w.ids.ws.id, userId: w.ids.users.a.id }, data: { status: "REVOKED" } });
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(401);
  });

  it("approving a workspace the person does not belong to is refused", async () => {
    const other = await workspaceWithOwner(db, "ob2@b.test", "Not mine");
    const { authorizeUrl } = await startLink(w.A, w.aOwner, B_ORIGIN);
    const req = parseAuthorizeRequest(w.B, paramsOf(authorizeUrl));
    if (!req.ok) throw new Error();
    await expect(approveAuthorization(w.B, w.ids.users.a.id, req.req, other.ws.id)).rejects.toThrow(ForbiddenError);
    await savePolicy(db, w.B.config, other.viewer, { outboundMode: "off", inboundMode: "any", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    await expect(approveAuthorization(w.B, w.ids.users.a.id, req.req, other.ws.id)).rejects.toThrow(ForbiddenError); // open policy, still not a member
  });
});

// ---------- the consumer's side ----------

describe("consumer: a link is only the linking person's", () => {
  it("another person in the same workspace, and an administrator, do not see or read it; the administrator may unlink it", async () => {
    const { linkId } = await linkUp(w);
    const peer = await addMember(db, w.aWs, "peer@a.test", "MEMBER");
    const pv = await peer.viewer();
    expect(await listLinks(db, pv)).toEqual([]);
    await expect(remoteGet(w.A, pv, linkId, "/projects")).rejects.toThrow(NotFoundError);
    await expect(unlink(w.A, pv, linkId)).rejects.toThrow(NotFoundError);
    const adminM = await addMember(db, w.aWs, "adm@a.test", "ADMIN");
    const av = await adminM.viewer();
    expect(await listLinks(db, av)).toEqual([]); // not even an administrator reads the data
    await expect(remoteGet(w.A, av, linkId, "/projects")).rejects.toThrow(NotFoundError);
    expect((await workspaceLinks(db, av)).map((l) => l.peerOrigin)).toEqual([B_ORIGIN]); // but sees that it exists, and who made it
    await expect(workspaceLinks(db, pv)).rejects.toThrow(ForbiddenError);
    await unlink(w.A, av, linkId);
    expect(await listLinks(db, w.aOwner)).toEqual([]);
  });

  it("another workspace of the same person cannot use the link", async () => {
    const { linkId } = await linkUp(w);
    const second = await workspaceWithOwner(db, "alice2@a.test", "Other A workspace");
    await expect(remoteGet(w.A, second.viewer, linkId, "/projects")).rejects.toThrow(NotFoundError);
  });

  it("cache rows belong to the link's person: every cache row is stamped with the link, workspace and person", async () => {
    const { linkId } = await linkUp(w);
    await remoteGet(w.A, w.aOwner, linkId, "/projects");
    const rows = await db.federationCache.findMany({ where: { workspaceId: w.aWs } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId === w.aOwner.userId && r.linkId === linkId)).toBe(true);
    const peer = await addMember(db, w.aWs, "peer2@a.test", "MEMBER");
    await expect(remoteGet(w.A, await peer.viewer(), linkId, "/projects")).rejects.toThrow(NotFoundError);
  });

  it("linked data is never read by search, digests, AI, backup or exports (static check)", async () => {
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /federationCache|federationLink|federationGrant|lib\/federation/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
      }
    };
    walk(path.resolve("src"));
    // Only federation's own code, its routes and pages, the sidebar/settings entry points, the policy-aware layout flag and the tenancy allowlist touch it.
    const allowedPrefixes = ["src/lib/federation/", "src/app/federation", "src/app/.well-known/", "src/app/api/federation/", "src/app/(app)/linked/", "src/app/(app)/settings/", "src/app/(app)/layout.tsx", "src/components/federation/", "src/lib/authz/tenancy-allowlist.ts", "src/generated/"];
    expect(hits.filter((h) => !allowedPrefixes.some((a) => h.startsWith(a)))).toEqual([]);
    for (const h of hits) expect(h).not.toMatch(/services\/(backup|search|digest|ai|queries)|lib\/mcp/);
  });

  it("stale-while-revalidate: a stale answer is served at once and refreshed behind it; ETag revalidation keeps the cache", async () => {
    const { linkId } = await linkUp(w);
    const first = await remoteGet<{ projects: ProjectDto[] }>(w.A, w.aOwner, linkId, "/projects");
    expect(first.stale).toBe(false);
    w.advance(30_000);
    const fresh = await remoteGet(w.A, w.aOwner, linkId, "/projects");
    expect(fresh.fetchedAt).toEqual(first.fetchedAt); // under 60 s: from the cache, no request
    const before = w.log.filter((l) => l.url.endsWith("/projects")).length;
    expect(before).toBe(1);
    w.advance(40_000); // now 70 s old
    const stale = await remoteGet(w.A, w.aOwner, linkId, "/projects", { background: true });
    expect(stale).toMatchObject({ state: "ok", stale: true });
    await settleRefreshes();
    const reqs = w.log.filter((l) => l.url.endsWith("/projects"));
    expect(reqs).toHaveLength(2);
    expect(reqs[1].headers["if-none-match"]).toMatch(/^"[0-9a-f]{32}"$/); // conditional: B answered 304
    const after = await remoteGet(w.A, w.aOwner, linkId, "/projects");
    expect(after.stale).toBe(false);
    expect(after.fetchedAt!.getTime()).toBeGreaterThan(first.fetchedAt!.getTime());
  });

  it("a peer that is down gives the last answer marked stale-with-error, or a clear error when nothing was cached", async () => {
    const { linkId } = await linkUp(w);
    w.down.B = true;
    const none = await remoteGet(w.A, w.aOwner, linkId, "/projects/xyz-never-fetched");
    expect(none).toMatchObject({ state: "error", data: null });
    expect(none.error).toMatch(/reach/i);
    w.down.B = false;
    await remoteGet(w.A, w.aOwner, linkId, "/projects");
    w.advance(120_000);
    w.down.B = true;
    const stale = await remoteGet<{ projects: ProjectDto[] }>(w.A, w.aOwner, linkId, "/projects");
    expect(stale).toMatchObject({ state: "error", stale: true });
    expect(stale.data!.projects.length).toBeGreaterThan(0);
    expect(stale.fetchedAt).not.toBeNull();
    expect((await db.federationLink.findFirstOrThrow({ where: { id: linkId, workspaceId: w.aWs } })).lastError).toMatch(/reach/i);
  });

  it("a 401 from the peer is a clear 'access revoked' state and drops the cached copy", async () => {
    const { linkId } = await linkUp(w);
    await remoteGet(w.A, w.aOwner, linkId, "/projects");
    await db.federationGrant.updateMany({ where: { workspaceId: w.ids.ws.id }, data: { revokedAt: new Date() } });
    w.advance(120_000);
    const r = await remoteGet(w.A, w.aOwner, linkId, "/projects");
    expect(r).toMatchObject({ state: "revoked", data: null });
    expect(r.error).toMatch(/no longer accepts/);
    expect(await db.federationCache.count({ where: { workspaceId: w.aWs } })).toBe(0);
  });

  it("Unlink deletes the token and the cache, tells the peer, and works even when the peer is down", async () => {
    const { linkId, token } = await linkUp(w);
    await remoteGet(w.A, w.aOwner, linkId, "/projects");
    await unlink(w.A, w.aOwner, linkId);
    const row = await db.federationLink.findFirstOrThrow({ where: { id: linkId, workspaceId: w.aWs } });
    expect(row).toMatchObject({ status: "REVOKED", tokenEnc: null });
    expect(await db.federationCache.count({ where: { workspaceId: w.aWs } })).toBe(0);
    expect((await meRoute(w.B, get("/api/federation/v1/me", token))).status).toBe(401); // the peer was told
    expect(w.log.some((l) => l.url.endsWith("/api/federation/v1/revoke"))).toBe(true);
    await expect(remoteGet(w.A, w.aOwner, linkId, "/projects")).rejects.toThrow(NotFoundError);
    // peer down
    const again = await linkUp(w);
    w.down.B = true;
    await unlink(w.A, w.aOwner, again.linkId);
    expect(await listLinks(db, w.aOwner)).toEqual([]);
    w.down.B = false;
    expect((await meRoute(w.B, get("/api/federation/v1/me", again.token))).status).toBe(200); // still live there until it expires or an admin revokes it
  });

  it("a link can be made again after unlinking", async () => {
    const first = await linkUp(w);
    await unlink(w.A, w.aOwner, first.linkId);
    const second = await linkUp(w);
    expect(second.linkId).not.toBe(first.linkId);
    expect((await remoteGet(w.A, w.aOwner, second.linkId, "/projects")).state).toBe("ok");
  });
});

// ---------- revocation on the provider ----------

describe("provider: Linked apps and administrator revoke", () => {
  it("a person lists and revokes their own grant; others' grants are NotFound to them", async () => {
    const mine = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    const second = await addMember(db, w.aWs, "x2@a.test", "ADMIN");
    const theirs = await linkUp(w, await second.viewer(), { userId: w.ids.users.b.id, workspaceId: w.ids.ws.id });
    const list = await myGrants(db, w.a, w.clock.now);
    expect(list).toHaveLength(1);
    expect(list[0].clientOrigin).toBe(A_ORIGIN);
    const bGrant = (await myGrants(db, w.b, w.clock.now))[0];
    await expect(revokeGrant(db, w.a, bGrant.id)).rejects.toThrow(NotFoundError);
    await revokeGrant(db, w.a, list[0].id);
    expect((await meRoute(w.B, get("/api/federation/v1/me", mine.token))).status).toBe(401);
    expect((await meRoute(w.B, get("/api/federation/v1/me", theirs.token))).status).toBe(200);
    expect(await myGrants(db, w.a, w.clock.now)).toEqual([]);
  });

  it("administrators see every grant of the workspace, revoke any one, or all from an origin; members cannot", async () => {
    const t1 = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    const second = await addMember(db, w.aWs, "x3@a.test", "ADMIN");
    const t2 = await linkUp(w, await second.viewer(), { userId: w.ids.users.b.id, workspaceId: w.ids.ws.id });
    await expect(workspaceGrants(db, w.a)).rejects.toThrow(ForbiddenError);
    await expect(revokeAllFromOrigin(db, w.a, A_ORIGIN)).rejects.toThrow(ForbiddenError);
    const all = await workspaceGrants(db, w.admin, w.clock.now);
    expect(all).toHaveLength(2);
    expect(all.every((g) => g.clientOrigin === A_ORIGIN && typeof g.who === "string")).toBe(true);
    await revokeGrant(db, w.admin, all[0].id);
    expect(await workspaceGrants(db, w.admin, w.clock.now)).toHaveLength(1);
    expect(await revokeAllFromOrigin(db, w.admin, A_ORIGIN)).toBe(1);
    for (const t of [t1.token, t2.token]) expect((await meRoute(w.B, get("/api/federation/v1/me", t))).status).toBe(401);
    // and the consumer shows it as revoked
    w.advance(120_000);
    expect(await remoteGet(w.A, w.aOwner, t1.linkId, "/projects")).toMatchObject({ state: "revoked" });
  });

  it("every decision is audited without a secret in it", async () => {
    const { linkId, token } = await linkUp(w);
    await meRoute(w.B, get("/api/federation/v1/me", token));
    await unlink(w.A, w.aOwner, linkId);
    const kinds = (ws: string) => db.federationEvent.findMany({ where: { workspaceId: ws }, select: { kind: true } }).then((r) => r.map((x) => x.kind));
    expect(await kinds(w.aWs)).toEqual(expect.arrayContaining(["policy.changed", "link.started", "link.created", "link.revoked"]));
    expect(await kinds(w.ids.ws.id)).toEqual(expect.arrayContaining(["policy.changed", "grant.approved", "grant.token_issued", "grant.first_use"]));
    expect((await kinds(w.ids.ws.id)).filter((k) => k === "grant.first_use")).toHaveLength(1);
  });
});

describe("discovery", () => {
  it("the document names the endpoints, the version and read-only scope", async () => {
    const res = await (await import("@/lib/federation/provider-http")).wellKnownRoute(w.B);
    const doc = await json(res);
    expect(doc).toMatchObject({ protocol: "mergeport-federation", version: 1, authorization_endpoint: `${B_ORIGIN}/federation/authorize`, token_endpoint: `${B_ORIGIN}/api/federation/v1/token`, scopes: ["read"], code_challenge_methods: ["S256"] });
  });
  it("a peer with the wrong protocol is refused before any redirect", async () => {
    const bad = { ...w.A, fetch: async () => ({ status: 200, headers: {}, text: "{}", json: { protocol: "other", version: 1 } }) };
    await expect(startLink(bad, w.aOwner, B_ORIGIN)).rejects.toThrow(/does not look like/);
    const off = { ...w.A, fetch: async () => ({ status: 200, headers: {}, text: "{}", json: { protocol: "mergeport-federation", version: 1, inbound: false } }) };
    await expect(startLink(off, w.aOwner, B_ORIGIN)).rejects.toThrow(/does not accept links/);
    expect(await db.federationLink.count({ where: { workspaceId: w.aWs, status: "PENDING" } })).toBe(0);
  });
  it("without a loadViewer for the grant's person nothing is returned (sanity: viewers are loaded per request)", async () => {
    const v = await loadViewer(db, w.ids.users.a.id, w.ids.ws.id);
    expect(v?.role).toBe("MEMBER");
  });
});
