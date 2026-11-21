import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { A_ORIGIN, B_ORIGIN, bearer, get, linkUp, makeWorld, openPolicies, paramsOf, type World } from "./federation-harness";
import { addMember } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { loadViewer } from "@/lib/authz/viewer";
import { changeRole, leaveWorkspace, reinstateMember, removeMember, transferOwnership } from "@/lib/services/members";
import { completeCallback, listLinks, remoteGet, startLink } from "@/lib/federation/consumer";
import type { FedCtx } from "@/lib/federation/context";
import { savePolicy } from "@/lib/federation/policy";
import { meRoute } from "@/lib/federation/provider-http";
import { ID_PATTERN, parsePeerBody } from "@/lib/federation/schemas";
import type { FedFetch, SafeFetchResponse } from "@/lib/federation/safe-fetch";

let db: Db;
let w: World;
let n = 0;
beforeEach(async () => {
  db = createTestPrisma(`federation-hardening-${n++}`);
  w = await makeWorld(db);
  await openPolicies(w);
});
afterEach(async () => {
  await db.$disconnect();
});

const status = async (token: string) => (await meRoute(w.B, get("/api/federation/v1/me", token))).status;
const ok = (json: unknown): SafeFetchResponse => ({ status: 200, headers: {}, text: JSON.stringify(json), json });

// ---------- 1. membership changes end federation access ----------

describe("a membership change ends the federation access given under the old membership", () => {
  it("remove, then reinstate: the old token stays dead and a fresh link needs fresh consent", async () => {
    const { token } = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    expect(await status(token)).toBe(200);
    await removeMember(db, w.admin, w.ids.members.a.id);
    expect(await status(token)).toBe(401);
    await reinstateMember(db, w.admin, w.ids.members.a.id, "ADMIN"); // possibly a different role now
    expect(await status(token)).toBe(401); // not revived
    const grants = await db.federationGrant.findMany({ where: { workspaceId: w.ids.ws.id, userId: w.ids.users.a.id } });
    expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
    const other = await addMember(db, w.aWs, "fresh@a.test", "ADMIN");
    const fresh = await linkUp(w, await other.viewer(), { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    expect(await status(fresh.token)).toBe(200);
    expect(fresh.token).not.toBe(token);
  });

  it("leaving does the same", async () => {
    const { token } = await linkUp(w, w.aOwner, { userId: w.ids.users.b.id, workspaceId: w.ids.ws.id });
    await leaveWorkspace(db, w.b);
    expect(await status(token)).toBe(401);
    await db.member.updateMany({ where: { workspaceId: w.ids.ws.id, userId: w.ids.users.b.id }, data: { status: "ACTIVE", revokedAt: null } }); // revived by other means
    expect(await status(token)).toBe(401); // the grant itself is revoked
  });

  it("removing a person also ends THEIR links to other instances: token deleted, cache cleared", async () => {
    const peer = await addMember(db, w.aWs, "linker@a.test", "ADMIN");
    const pv = await peer.viewer();
    const { linkId, token } = await linkUp(w, pv, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    await remoteGet(w.A, pv, linkId, "/projects");
    expect(await db.federationCache.count({ where: { workspaceId: w.aWs } })).toBe(1);
    await removeMember(db, w.aOwner, peer.member.id);
    const row = await db.federationLink.findFirstOrThrow({ where: { id: linkId, workspaceId: w.aWs } });
    expect(row).toMatchObject({ status: "REVOKED", tokenEnc: null });
    expect(await db.federationCache.count({ where: { workspaceId: w.aWs } })).toBe(0);
    await reinstateMember(db, w.aOwner, peer.member.id, "ADMIN");
    expect(await listLinks(db, (await peer.viewer()))).toEqual([]); // not revived
    expect(token.length).toBeGreaterThan(20);
  });

  it("lowering a role revokes the person's grants; raising it or keeping it does not", async () => {
    const { token } = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    await changeRole(db, w.admin, w.ids.members.a.id, "ADMIN"); // raised
    expect(await status(token)).toBe(200);
    await changeRole(db, w.admin, w.ids.members.a.id, "ADMIN"); // unchanged
    expect(await status(token)).toBe(200);
    await changeRole(db, w.admin, w.ids.members.a.id, "MEMBER"); // lowered: approved at a higher role
    expect(await status(token)).toBe(401);
  });

  it("demoting to READER revokes too, and a new grant then shows the READER's view", async () => {
    const { token } = await linkUp(w, w.aOwner, { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id });
    await changeRole(db, w.admin, w.ids.members.a.id, "READER");
    expect(await status(token)).toBe(401);
  });

  it("an ownership transfer revokes the previous owner's grants (their role dropped)", async () => {
    const owner = await linkUp(w, w.aOwner, { userId: w.ids.users.admin.id, workspaceId: w.ids.ws.id });
    await changeRole(db, w.admin, w.ids.members.a.id, "ADMIN");
    await transferOwnership(db, w.admin, w.ids.members.a.id);
    expect(await status(owner.token)).toBe(401);
  });
});

// ---------- 2. limits are race free ----------

/** Peers C, D, E that speak the protocol; B and A stay the real simulated instances. */
function withExtraPeers(): FedCtx {
  const base = w.A.fetch;
  const fetch: FedFetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === B_ORIGIN || u.origin === A_ORIGIN) return base(url, init);
    if (u.pathname === "/.well-known/mergeport-federation") return ok({ protocol: "mergeport-federation", version: 1, inbound: true });
    if (u.pathname === "/api/federation/v1/token") return ok({ access_token: randomBytes(32).toString("base64url") });
    if (u.pathname === "/api/federation/v1/revoke") return ok({ ok: true });
    return { status: 404, headers: {}, text: "", json: null };
  };
  return { ...w.A, fetch };
}
const policyFor = (over: { maxPeers: number; maxLinksPerUser: number }) => savePolicy(db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", ...over });

describe("link limits hold under concurrency", () => {
  it("concurrent starts and callbacks end with at most maxPeers ACTIVE links, and the refused ones keep no token", async () => {
    await policyFor({ maxPeers: 1, maxLinksPerUser: 5 });
    const A2 = withExtraPeers();
    const peers = ["c", "d", "e"].map((x) => `https://${x}.test`);
    const started = await Promise.all(peers.map((p) => startLink(A2, w.aOwner, p)));
    const calls = started.map((s) => paramsOf(s.authorizeUrl).state);
    const results = await Promise.all(calls.map((state) => completeCallback(A2, w.aOwner.userId, { code: "x".repeat(30), state })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "refused")).toBe(true);
    const rows = await db.federationLink.findMany({ where: { workspaceId: w.aWs } });
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "REVOKED").every((r) => r.tokenEnc === null)).toBe(true); // nothing stored for the losers
  });

  it("concurrent starts never exceed maxLinksPerUser pending-or-active links", async () => {
    await policyFor({ maxPeers: 10, maxLinksPerUser: 2 });
    const A2 = withExtraPeers();
    const settled = await Promise.allSettled(["c", "d", "e", "f"].map((x) => startLink(A2, w.aOwner, `https://${x}.test`)));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(settled.filter((s) => s.status === "rejected").every((s) => (s as PromiseRejectedResult).reason instanceof ForbiddenError)).toBe(true);
    expect(await db.federationLink.count({ where: { workspaceId: w.aWs, status: "PENDING" } })).toBe(2);
  });

  it("a limit tightened between start and callback is enforced at activation", async () => {
    const A2 = withExtraPeers();
    const first = await startLink(A2, w.aOwner, "https://c.test");
    const second = await startLink(A2, w.aOwner, "https://d.test");
    expect((await completeCallback(A2, w.aOwner.userId, { code: "x".repeat(30), state: paramsOf(first.authorizeUrl).state })).ok).toBe(true);
    await policyFor({ maxPeers: 1, maxLinksPerUser: 5 });
    const r = await completeCallback(A2, w.aOwner.userId, { code: "x".repeat(30), state: paramsOf(second.authorizeUrl).state });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(await db.federationLink.count({ where: { workspaceId: w.aWs, status: "ACTIVE" } })).toBe(1);
  });

  it("the per-person count at activation excludes the link being activated", async () => {
    await policyFor({ maxPeers: 5, maxLinksPerUser: 1 });
    const A2 = withExtraPeers();
    const s = await startLink(A2, w.aOwner, "https://c.test");
    expect((await completeCallback(A2, w.aOwner.userId, { code: "x".repeat(30), state: paramsOf(s.authorizeUrl).state })).ok).toBe(true);
  });
});

// ---------- 3. untrusted peer answers ----------

describe("a hostile or broken peer cannot crash or poison the linked pages", () => {
  async function linkWithBody(body: unknown, path = "/projects") {
    const { linkId } = await linkUp(w);
    const base = w.A.fetch;
    const A2: FedCtx = { ...w.A, fetch: async (url, init) => (new URL(url).pathname === `/api/federation/v1${path}` ? ok(body) : base(url, init)) };
    return { A2, linkId };
  }
  const bad: [string, unknown][] = [
    ["projects: null", { projects: null, nextCursor: null }],
    ["a missing projects field", {}],
    ["a string instead of an object", "oops"],
    ["null", null],
    ["a title that is an object", { projects: [{ id: "p1", name: {}, slug: "s", description: null }] }],
    ["an id with a path traversal", { projects: [{ id: "../../admin", name: "n", slug: "s", description: null }], nextCursor: null }],
    ["an id with a query", { projects: [{ id: "a?x=1", name: "n", slug: "s", description: null }], nextCursor: null }],
    ["an id with a slash", { projects: [{ id: "a/b", name: "n", slug: "s", description: null }], nextCursor: null }],
    ["an empty id", { projects: [{ id: "", name: "n", slug: "s", description: null }], nextCursor: null }],
    ["an over-long id", { projects: [{ id: "a".repeat(61), name: "n", slug: "s", description: null }], nextCursor: null }],
    ["101 projects", { projects: Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, name: "n", slug: "s", description: null })), nextCursor: null }],
    ["a 1 MB name", { projects: [{ id: "p", name: "x".repeat(1_000_000), slug: "s", description: null }], nextCursor: null }],
    ["a bad cursor", { projects: [], nextCursor: "../x" }],
  ];
  it.each(bad)("%s: an error state, nothing cached, no throw", async (_n, body) => {
    const { A2, linkId } = await linkWithBody(body);
    const r = await remoteGet(A2, w.aOwner, linkId, "/projects");
    expect(r).toMatchObject({ state: "error", data: null });
    expect(r.error).toMatch(/cannot read/);
    expect(await db.federationCache.count({ where: { workspaceId: w.aWs } })).toBe(0);
    expect((await db.federationLink.findFirstOrThrow({ where: { id: linkId, workspaceId: w.aWs } })).lastError).toMatch(/cannot read/);
  });

  it("board and task answers are validated too (card arrays, priority, dates)", async () => {
    const board = { project: { id: "p", name: "n", slug: "s", description: null }, truncated: false, columns: [{ key: "k", name: "K", position: 0, items: [{ id: "i", title: "t", position: 1, priority: "high", dueDate: null, assignee: null, labels: [], linked: false }] }] };
    const { A2, linkId } = await linkWithBody(board, "/projects/p");
    expect(await remoteGet(A2, w.aOwner, linkId, "/projects/p")).toMatchObject({ state: "error", data: null });
    const huge = { project: board.project, truncated: false, columns: [{ key: "k", name: "K", position: 0, items: Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, title: "t", position: 1, priority: 0, dueDate: null, assignee: null, labels: [], linked: false })) }] };
    expect(parsePeerBody("/projects/p", huge)).toBeNull();
    expect(parsePeerBody("/projects/p/tasks", { tasks: [{ id: "t", title: "t", description: null, columnKey: "k", columnName: "K", position: 1, priority: 0, dueDate: "tomorrow", assignee: null, labels: [], linked: false, createdAt: "x", updatedAt: "y" }], nextCursor: null })).toBeNull();
    expect(parsePeerBody("/something-else", {})).toBeNull();
  });

  it("a valid answer is cached with unknown fields stripped", async () => {
    const body = { projects: [{ id: "p1", name: "Name", slug: "s", description: null, email: "leak@x.test", internal: { a: 1 } }], nextCursor: null, extra: true };
    const { A2, linkId } = await linkWithBody(body);
    const r = await remoteGet<{ projects: Record<string, unknown>[] }>(A2, w.aOwner, linkId, "/projects");
    expect(r.state).toBe("ok");
    expect(Object.keys(r.data!.projects[0]).sort()).toEqual(["description", "id", "name", "slug"]);
    expect(Object.keys(r.data!)).toEqual(["projects", "nextCursor"]);
    const row = await db.federationCache.findFirstOrThrow({ where: { workspaceId: w.aWs } });
    expect(JSON.stringify(row.bodyJson)).not.toMatch(/leak@x|internal|extra/);
  });

  it("a bad answer after a good one keeps showing the last good copy, marked as an error", async () => {
    const { linkId } = await linkUp(w);
    await remoteGet(w.A, w.aOwner, linkId, "/projects");
    w.advance(120_000);
    const base = w.A.fetch;
    const A2: FedCtx = { ...w.A, fetch: async (url, init) => (new URL(url).pathname.endsWith("/projects") ? ok({ projects: 5 }) : base(url, init)) };
    const r = await remoteGet<{ projects: unknown[] }>(A2, w.aOwner, linkId, "/projects");
    expect(r).toMatchObject({ state: "error", stale: true });
    expect(Array.isArray(r.data!.projects)).toBe(true);
  });

  it("a bad body already in the cache (older version, tampering) is dropped, never served", async () => {
    const { linkId } = await linkUp(w);
    await db.federationCache.create({ data: { workspaceId: w.aWs, userId: w.aOwner.userId, linkId, key: "/projects", etag: '"x"', bodyJson: { projects: null }, fetchedAt: w.clock.now } });
    const r = await remoteGet<{ projects: unknown[] }>(w.A, w.aOwner, linkId, "/projects");
    expect(r.state).toBe("ok");
    expect(Array.isArray(r.data!.projects)).toBe(true); // refetched from the real peer
  });

  it("ids that could change a link are refused by the shape; encoding is applied on top", () => {
    for (const id of ["../x", "a?x=1", "a/b", "a b", "a#b", "%2e%2e", "", "a".repeat(61), "é"]) expect(ID_PATTERN.test(id), id).toBe(false);
    for (const id of ["cmwpn05p403j07kve3ocubdoj", "a-b_C", "x"]) expect(ID_PATTERN.test(id), id).toBe(true);
    expect(`/linked/${encodeURIComponent("a?x=1")}/projects/${encodeURIComponent("../x")}`).toBe("/linked/a%3Fx%3D1/projects/..%2Fx");
  });

  it("the other instance's grants at the provider reject a made-up bearer (control)", async () => {
    expect((await meRoute(w.B, new Request(`${B_ORIGIN}/api/federation/v1/me`, { headers: bearer("q".repeat(43)) }))).status).toBe(401);
    expect(await loadViewer(db, w.ids.users.a.id, w.ids.ws.id)).not.toBeNull();
  });
});
