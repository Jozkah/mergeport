import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { seedDemo } from "@/lib/demo/seed";
import { BASE } from "./helpers";
import { savePolicy } from "@/lib/federation/policy";
import { KEY } from "./federation-harness";

/**
 * The real route files, pages and server actions, with this instance playing the PROVIDER (https://app.test). Covers what the
 * unit-level two-instance tests cannot: the 404 when federation is off, the proxy's Origin rules, framing, CSRF on the consent form.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: "app.test" }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const CLIENT = "https://client.test";
let n = 0;
beforeEach(() => {
  state.db = createTestPrisma(`federation-routes-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});

const on = () => {
  vi.stubEnv("MERGEPORT_FEDERATION", "any");
  vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", KEY.toString("hex"));
};
const req = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, { ...init, headers: { host: HOST, ...((init.headers as Record<string, string>) ?? {}) } });
const digestOf = async (p: Promise<unknown>) => (await p.then(() => null, (e: { digest?: string }) => e.digest ?? String(e))) as string | null;

async function signedIn() {
  const w = await workspaceWithOwner(state.db!, "owner@app.test", "Provider Co");
  const { token } = await createSession(state.db!, w.owner.id, new Date(), w.ws.id);
  state.jar.set(SESSION_COOKIE, { value: token, options: {} });
  return w;
}

const ROUTES = async () => ({
  wellKnown: (await import("@/app/.well-known/mergeport-federation/route")).GET,
  token: (await import("@/app/api/federation/v1/token/route")).POST,
  revoke: (await import("@/app/api/federation/v1/revoke/route")).POST,
  me: (await import("@/app/api/federation/v1/me/route")).GET,
  projects: (await import("@/app/api/federation/v1/projects/route")).GET,
  project: (await import("@/app/api/federation/v1/projects/[id]/route")).GET,
  tasks: (await import("@/app/api/federation/v1/projects/[id]/tasks/route")).GET,
  callback: (await import("@/app/federation/callback/route")).GET,
});
const call = async (r: Awaited<ReturnType<typeof ROUTES>>) => ({
  wellKnown: await r.wellKnown(req("/.well-known/mergeport-federation")),
  token: await r.token(req("/api/federation/v1/token", { method: "POST", body: "{}" })),
  revoke: await r.revoke(req("/api/federation/v1/revoke", { method: "POST", body: "{}" })),
  me: await r.me(req("/api/federation/v1/me")),
  projects: await r.projects(req("/api/federation/v1/projects")),
  project: await r.project(req("/api/federation/v1/projects/x"), { params: Promise.resolve({ id: "x" }) }),
  tasks: await r.tasks(req("/api/federation/v1/projects/x/tasks"), { params: Promise.resolve({ id: "x" }) }),
  callback: await r.callback(req("/federation/callback?code=c&state=s")),
});

describe("federation is completely absent (404) unless the operator turned it on", () => {
  it.each([
    ["the ceiling is off (default)", () => {}],
    ["the ceiling is explicitly off", () => vi.stubEnv("MERGEPORT_FEDERATION", "off")],
    ["the value is not recognised", () => (vi.stubEnv("MERGEPORT_FEDERATION", "yes"), vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", KEY.toString("hex")))],
    ["it is on but there is no encryption key", () => vi.stubEnv("MERGEPORT_FEDERATION", "any")],
    ["it is on but the instance is not hosted", () => (on(), vi.stubEnv("MERGEPORT_PUBLIC_URL", ""))],
  ])("%s: every route, the pages and the actions", async (_n, setup) => {
    setup();
    const r = await call(await ROUTES());
    for (const [name, res] of Object.entries(r)) expect(res.status, name).toBe(404);
    await signedIn();
    expect(await digestOf((await import("@/app/federation/authorize/page")).default({ searchParams: Promise.resolve({}) }))).toContain("404");
    expect(await digestOf((await import("@/app/(app)/linked/page")).default({ searchParams: Promise.resolve({}) }))).toContain("404");
    // An administrator on a server with federation on but no key still gets the settings page, to be told why it does not work.
    const settings = await digestOf((await import("@/app/(app)/settings/linked/page")).default());
    if (_n.includes("no encryption key")) expect(settings).toBeNull();
    else expect(settings).toContain("404");
    const actions = await import("@/app/federation-actions");
    const fd = new FormData();
    fd.set("address", "https://peer.test");
    expect(await actions.startLinkAction(fd)).toMatchObject({ ok: false });
    expect(await actions.saveFederationPolicyAction(fd)).toMatchObject({ ok: false });
    expect(await state.db!.federationLink.count()).toBe(0);
  });

  it("when on: discovery answers, the token and API endpoints refuse garbage the right way", async () => {
    on();
    const r = await call(await ROUTES());
    expect(r.wellKnown.status).toBe(200);
    expect(await r.wellKnown.json()).toMatchObject({ protocol: "mergeport-federation", version: 1, token_endpoint: `${ORIGIN}/api/federation/v1/token` });
    expect(r.token.status).toBe(400);
    expect(r.revoke.status).toBe(200);
    for (const k of ["me", "projects", "project", "tasks"] as const) expect(r[k].status, k).toBe(401);
    expect(r.callback.status).toBe(303);
    expect(r.callback.headers.get("location")).toBe(`${ORIGIN}/linked?result=signin`); // no session: nothing exchanged, the code goes nowhere
  });
});

describe("the callback never reflects the request", () => {
  it("answers with a fixed result code only, whatever the query says", async () => {
    on();
    await signedIn();
    const r = await (await ROUTES()).callback(req("/federation/callback?code=SECRETCODE&state=SECRETSTATE&error=https://evil.test"));
    const loc = r.headers.get("location")!;
    expect(loc).toBe(`${ORIGIN}/linked?result=invalid`);
    expect(loc).not.toMatch(/SECRET|evil/);
  });
});

describe("the consent page (this instance as provider)", () => {
  const good = { response_type: "code", client_origin: CLIENT, redirect_uri: `${CLIENT}/federation/callback`, state: "s".repeat(40), code_challenge: "c".repeat(43), code_challenge_method: "S256", scope: "read" };
  const page = async (sp: Record<string, string>) => (await import("@/app/federation/authorize/page")).default({ searchParams: Promise.resolve(sp) });
  /** Every string in a rendered element tree (function types and cycles skipped), enough to see what the page says and which fields its forms carry. */
  const text = (el: unknown): string => {
    const seen = new WeakSet<object>();
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") return void out.push(v);
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      for (const [k, x] of Object.entries(v)) {
        if (k === "type" || k === "_owner" || k === "_store") continue;
        out.push(k);
        walk(x);
      }
    };
    walk(el);
    return out.join(" ");
  };

  it("an invalid request is an error page, never a redirect", async () => {
    on();
    for (const bad of [{ redirect_uri: "https://evil.test/federation/callback" }, { redirect_uri: `${CLIENT}/federation/callback/../x` }, { client_origin: "javascript:alert(1)" }, { state: "x" }]) {
      const el = await page({ ...good, ...bad });
      expect(text(el), JSON.stringify(bad)).toContain("This request cannot be approved");
    }
  });

  it("signed out: sends to sign-in and brings the person back to the same request", async () => {
    on();
    const d = await digestOf(page(good));
    expect(d).toContain("NEXT_REDIRECT");
    const next = decodeURIComponent(/\/sign-in\?next=([^;]+)/.exec(d!)![1]);
    expect(next.startsWith("/federation/authorize?")).toBe(true);
    expect(Object.fromEntries(new URL(next, ORIGIN).searchParams)).toMatchObject({ client_origin: CLIENT, redirect_uri: `${CLIENT}/federation/callback`, state: good.state });
  });

  it("signed in but the workspace does not accept links: says so, offers nothing to approve", async () => {
    on();
    await signedIn(); // default policy: inbound off
    const t = text(await page(good));
    expect(t).toContain("Nothing can be shared");
    expect(t).not.toContain("Approve read-only access");
  });

  it("signed in with an open policy: shows who asks, the read-only scope and the Approve/Deny forms", async () => {
    on();
    const w = await signedIn();
    await savePolicy(state.db!, { mode: "any", allowlist: [], allowInsecure: false, key: KEY }, w.viewer, { outboundMode: "off", inboundMode: "any", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    const t = text(await page(good));
    expect(t).toContain("client.test");
    expect(t).toContain("read-only access");
    expect(t).toContain("Provider Co");
    expect(t).toContain("It never includes");
    expect(t).toContain("csrf"); // the forms carry the session's CSRF token
  });
});

describe("the consent actions", () => {
  const fields = (csrf: string, over: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ client_origin: CLIENT, redirect_uri: `${CLIENT}/federation/callback`, state: "s".repeat(40), code_challenge: "c".repeat(43), scope: "read", csrf, ...over })) fd.set(k, v);
    return fd;
  };
  async function open() {
    on();
    const w = await signedIn();
    await savePolicy(state.db!, { mode: "any", allowlist: [], allowInsecure: false, key: KEY }, w.viewer, { outboundMode: "off", inboundMode: "any", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 });
    const session = await state.db!.session.findFirstOrThrow({ where: { userId: w.owner.id } });
    return { w, csrf: session.csrfToken };
  }

  it("approve needs the session's CSRF token; with it the answer is the callback address carrying a one-time code and the state", async () => {
    const { w, csrf } = await open();
    const { approveFederationAction } = await import("@/app/federation-actions");
    expect(await approveFederationAction(fields("wrong"))).toMatchObject({ ok: false });
    expect(await approveFederationAction(fields(""))).toMatchObject({ ok: false });
    expect(await state.db!.federationGrant.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    const r = await approveFederationAction(fields(csrf));
    expect(r.ok).toBe(true);
    const to = new URL(((r as unknown) as { data: { redirect: string } }).data.redirect);
    expect(to.origin + to.pathname).toBe(`${CLIENT}/federation/callback`);
    expect(to.searchParams.get("state")).toBe("s".repeat(40));
    expect(to.searchParams.get("code")!.length).toBeGreaterThan(30);
    expect(await state.db!.federationGrant.count({ where: { workspaceId: w.ws.id, userId: w.owner.id, clientOrigin: CLIENT } })).toBe(1);
  });

  it("approve re-validates the request: a forged return address or an unlisted workspace is refused and nothing is issued", async () => {
    const { w, csrf } = await open();
    const { approveFederationAction } = await import("@/app/federation-actions");
    expect(await approveFederationAction(fields(csrf, { redirect_uri: "https://evil.test/federation/callback" }))).toMatchObject({ ok: false });
    const other = await workspaceWithOwner(state.db!, "other-owner@app.test", "Someone else's");
    expect(await approveFederationAction(fields(csrf, { workspaceId: other.ws.id }))).toMatchObject({ ok: false });
    expect(await state.db!.federationGrant.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    expect(await state.db!.federationGrant.count({ where: { workspaceId: other.ws.id } })).toBe(0);
  });

  it("deny needs the CSRF token and sends access_denied with the state, issuing nothing", async () => {
    const { w, csrf } = await open();
    const { denyFederationAction } = await import("@/app/federation-actions");
    expect(await denyFederationAction(fields("nope"))).toMatchObject({ ok: false });
    const r = await denyFederationAction(fields(csrf));
    const to = new URL(((r as unknown) as { data: { redirect: string } }).data.redirect);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("s".repeat(40));
    expect(to.searchParams.has("code")).toBe(false);
    expect(await state.db!.federationGrant.count({ where: { workspaceId: w.ws.id } })).toBe(0);
  });

  it("a READER may approve their own read-only share, but can never start a link", async () => {
    const { w, csrf: _ } = await open();
    const reader = await addMember(state.db!, w.ws.id, "reader@app.test", "READER");
    const { token } = await createSession(state.db!, reader.user.id, new Date(), w.ws.id);
    state.jar.set(SESSION_COOKIE, { value: token, options: {} });
    const rcsrf = (await state.db!.session.findFirstOrThrow({ where: { userId: reader.user.id } })).csrfToken;
    const { approveFederationAction, startLinkAction } = await import("@/app/federation-actions");
    expect((await approveFederationAction(fields(rcsrf))).ok).toBe(true);
    const fd = new FormData();
    fd.set("address", "https://peer.test");
    expect(await startLinkAction(fd)).toMatchObject({ ok: false });
    expect(await state.db!.federationLink.count()).toBe(0);
  });

  it("settings writes are administrator-only", async () => {
    const { w } = await open();
    const member = await addMember(state.db!, w.ws.id, "mem@app.test", "MEMBER");
    const { token } = await createSession(state.db!, member.user.id, new Date(), w.ws.id);
    state.jar.set(SESSION_COOKIE, { value: token, options: {} });
    const { saveFederationPolicyAction, revokeAllFromOriginAction } = await import("@/app/federation-actions");
    const fd = new FormData();
    for (const [k, v] of Object.entries({ outboundMode: "any", inboundMode: "any", allowlist: "", whoCanLink: "MEMBER", maxLinksPerUser: "5", maxPeers: "5", origin: CLIENT })) fd.set(k, v);
    expect(await digestOf(saveFederationPolicyAction(fd))).toContain("404"); // requireAdminViewer: the same 404 as a missing page
    expect(await digestOf(revokeAllFromOriginAction(fd))).toContain("404");
    expect((await state.db!.federationPolicy.findUnique({ where: { workspaceId: w.ws.id } }))?.outboundMode).toBe("off");
  });
});

// ---------- the proxy ----------

describe("proxy: Origin rules, server-to-server exemption, framing", () => {
  const proxyAt = async (path: string, init: { method?: string; headers?: Record<string, string>; host?: string } = {}) => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const host = init.host ?? HOST;
    return proxy(new NextRequest(`https://${host}${path}`, { method: init.method ?? "GET", headers: { host, ...(init.headers ?? {}) } }));
  };

  it("the token and revoke endpoints accept a server-to-server POST (no Origin, no Sec-Fetch-Site); nothing else does", async () => {
    for (const p of ["/api/federation/v1/token", "/api/federation/v1/revoke"]) expect((await proxyAt(p, { method: "POST" })).status, p).toBe(200);
    for (const p of ["/api/federation/v1/me", "/federation/authorize", "/federation/callback", "/api/backup/restore", "/sign-in"]) expect((await proxyAt(p, { method: "POST" })).status, p).toBe(403);
  });

  it("the exemption exists only when hosted, and only for those two exact paths", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const r = proxy(new NextRequest("http://127.0.0.1:3000/api/federation/v1/token", { method: "POST", headers: { host: "127.0.0.1:3000" } }));
    expect(r.status).toBe(403);
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    for (const p of ["/api/federation/v1/token/", "/api/federation/v1/tokenx", "/api/federation/v1/token/../me"]) expect((await proxyAt(p, { method: "POST" })).status, p).toBe(403);
  });

  it("the consent form post is subject to the Origin rules: cross-site and Origin: null without same-origin are refused", async () => {
    const act = (headers: Record<string, string>) => proxyAt("/federation/authorize", { method: "POST", headers });
    expect((await act({ origin: "https://evil.test" })).status).toBe(403);
    expect((await act({ origin: "https://evil.test", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await act({ origin: "null" })).status).toBe(403);
    expect((await act({ origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await act({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await act({ origin: ORIGIN })).status).toBe(200);
    expect((await act({ origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("the approval page cannot be framed (CSP frame-ancestors and X-Frame-Options)", async () => {
    const res = await proxyAt("/federation/authorize?client_origin=x");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const api = await proxyAt("/api/federation/v1/me");
    expect(api.headers.get("cache-control")).toBe("no-store");
  });

  it("a Host that is not the public one is refused for federation paths too", async () => {
    expect((await proxyAt("/.well-known/mergeport-federation", { host: "evil.test" })).status).toBe(403);
    expect((await proxyAt("/api/federation/v1/token", { method: "POST", host: "127.0.0.1:3000" })).status).toBe(403);
  });
});

describe("a seeded second workspace on the same database is untouched by any of this", () => {
  it("the federation tables start empty and the tenancy classification includes them", async () => {
    await seedDemo(state.db!, BASE);
    for (const t of ["federationPolicy", "federationLink", "federationGrant", "federationCache", "federationEvent"] as const) expect(await (state.db![t] as unknown as { count(): Promise<number> }).count(), t).toBe(0);
  });
});
