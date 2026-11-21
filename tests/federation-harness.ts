import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import { BASE } from "./helpers";
import { workspaceWithOwner } from "./roles-helpers";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import type { FederationConfig } from "@/lib/federation/config";
import type { FedCtx } from "@/lib/federation/context";
import { completeCallback, startLink } from "@/lib/federation/consumer";
import { savePolicy } from "@/lib/federation/policy";
import { approveAuthorization, parseAuthorizeRequest } from "@/lib/federation/provider";
import { meRoute, projectRoute, projectsRoute, revokeRoute, tasksRoute, tokenRoute, wellKnownRoute } from "@/lib/federation/provider-http";
import { SafeFetchError, type FedFetch } from "@/lib/federation/safe-fetch";
import { decryptSecret } from "@/lib/federation/config";

/**
 * Two logical instances in one test database: A (https://a.test, where the person lives) and B (https://b.test, which owns the data,
 * seeded with the demo workspace). They share nothing but the injected fetch: it turns a request to one instance's origin into a call
 * of THAT instance's route handlers with THAT instance's context, exactly what the network would do. Each has its own clock-sharing
 * context and operator config. B's data is the demo workspace (users admin/a/b), A's is a fresh workspace with an owner.
 */
export const A_ORIGIN = "https://a.test";
export const B_ORIGIN = "https://b.test";

export type World = {
  db: Db;
  ids: DemoIds;
  A: FedCtx;
  B: FedCtx;
  /** Requests the simulated network carried: `${method} ${url}` plus the headers sent. */
  log: { method: string; url: string; headers: Record<string, string>; body?: string }[];
  /** The consumer workspace's owner and viewer (instance A). */
  aOwner: Viewer;
  aWs: string;
  /** Provider viewers (instance B). */
  admin: Viewer;
  a: Viewer;
  b: Viewer;
  clock: { now: Date };
  advance(ms: number): void;
  /** When set, requests to B fail like a dead host. */
  down: { B: boolean };
};

export const KEY = randomBytes(32);
export const config = (over: Partial<FederationConfig> = {}): FederationConfig => ({ mode: "any", allowlist: [], allowInsecure: false, key: KEY, ...over });

export async function makeWorld(db: Db): Promise<World> {
  const ids = await seedDemo(db, BASE);
  const owner = await workspaceWithOwner(db, "alice@a.test", "Alice Co");
  const clock = { now: new Date("2026-11-22T12:00:00Z") };
  const log: World["log"] = [];
  const down = { B: false };
  const mk = (selfOrigin: string, ip: string): FedCtx => ({ db, selfOrigin, config: config(), fetch: null as unknown as FedFetch, now: () => clock.now, ip });
  const A = mk(A_ORIGIN, "198.51.100.10");
  const B = mk(B_ORIGIN, "203.0.113.20");

  /** The simulated network. `from` is whose outgoing call it is (it only decides the client address the target sees). */
  const net = (from: FedCtx): FedFetch => async (url, init) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    log.push({ method: init?.method ?? "GET", url, headers, body: init?.body });
    const target = u.origin === B_ORIGIN ? B : u.origin === A_ORIGIN ? A : null;
    if (!target || (target === B && down.B)) throw new SafeFetchError("network", "Could not reach the other instance.");
    const ctx = { ...target, ip: from.ip };
    const req = new Request(url, { method: init?.method ?? "GET", headers, body: init?.body });
    const p = u.pathname;
    let res: Response;
    if (p === "/.well-known/mergeport-federation") res = wellKnownRoute(ctx);
    else if (p === "/api/federation/v1/token") res = await tokenRoute(ctx, req);
    else if (p === "/api/federation/v1/revoke") res = await revokeRoute(ctx, req);
    else if (p === "/api/federation/v1/me") res = await meRoute(ctx, req);
    else if (p === "/api/federation/v1/projects") res = await projectsRoute(ctx, req);
    else if (/^\/api\/federation\/v1\/projects\/[^/]+\/tasks$/.test(p)) res = await tasksRoute(ctx, req, p.split("/")[5]);
    else if (/^\/api\/federation\/v1\/projects\/[^/]+$/.test(p)) res = await projectRoute(ctx, req, p.split("/")[5]);
    else res = new Response("Not found", { status: 404 });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json: ct.includes("json") && text ? JSON.parse(text) : null };
  };
  A.fetch = net(A);
  B.fetch = net(B);

  const w: World = {
    db, ids, A, B, log, clock, down,
    aOwner: owner.viewer,
    aWs: owner.ws.id,
    admin: (await loadViewer(db, ids.users.admin.id, ids.ws.id))!,
    a: (await loadViewer(db, ids.users.a.id, ids.ws.id))!,
    b: (await loadViewer(db, ids.users.b.id, ids.ws.id))!,
    advance: (ms) => void (clock.now = new Date(clock.now.getTime() + ms)),
  };
  return w;
}

/** Both workspaces open: A may link out to any instance, B accepts any instance. */
export async function openPolicies(w: World, over: { a?: Parameters<typeof savePolicy>[3]; b?: Parameters<typeof savePolicy>[3] } = {}) {
  await savePolicy(w.db, w.A.config, w.aOwner, { outboundMode: "any", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5, ...over.a });
  await savePolicy(w.db, w.B.config, w.admin, { outboundMode: "off", inboundMode: "any", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5, ...over.b });
}

export const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

/** Runs the whole handshake for `consumer` (an A viewer) against B user `providerUserId` in `providerWorkspaceId`. Returns the link id and B's access token. */
export async function linkUp(w: World, consumer: Viewer = w.aOwner, provider: { userId: string; workspaceId: string } = { userId: w.ids.users.a.id, workspaceId: w.ids.ws.id }) {
  const { authorizeUrl } = await startLink(w.A, consumer, B_ORIGIN);
  const parsed = parseAuthorizeRequest(w.B, paramsOf(authorizeUrl));
  if (!parsed.ok) throw new Error(parsed.error);
  const { redirectTo } = await approveAuthorization(w.B, provider.userId, parsed.req, provider.workspaceId);
  const back = paramsOf(redirectTo);
  const r = await completeCallback(w.A, consumer.userId, { code: back.code, state: back.state });
  if (!r.ok) throw new Error(r.error);
  const link = await w.db.federationLink.findFirstOrThrow({ where: { id: r.linkId, workspaceId: consumer.workspaceId } });
  const token = decryptSecret(link.tokenEnc!, KEY, `token:${link.id}`)!;
  return { linkId: r.linkId, token, authorizeUrl, code: back.code, state: back.state };
}

export const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
export const get = (path: string, token: string, headers: Record<string, string> = {}) => new Request(`${B_ORIGIN}${path}`, { headers: bearer(token, headers) });
