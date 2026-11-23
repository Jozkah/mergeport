import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { BASE } from "./helpers";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { sha256 } from "@/lib/crypto";
import { changeRole, removeMember } from "@/lib/services/members";
import { createApiToken, listApiTokens } from "@/lib/services/api-tokens";
import { MAX_CLIENTS, issueCode, listGrants, parseAuthorize, revokeGrant, validRedirectUri } from "@/lib/services/oauth";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

const session = vi.hoisted(() => ({ current: null as null | { viewer: unknown; user: { id: string }; csrf: string } }));
vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));
vi.mock("@/lib/auth/current", () => ({ requireViewer: async () => session.current! }));

let n = 0;
let ids: DemoIds;
let admin: Viewer;
let a: Viewer;
let b: Viewer;
const db = () => state.db!;
const REDIRECT = "https://claude.example/api/mcp/auth_callback";
const MCP = `${ORIGIN}/api/mcp`;

beforeEach(async () => {
  state.db = createTestPrisma(`oauth-${n++}`);
  ids = await seedDemo(db(), BASE);
  [admin, a, b] = (await Promise.all([ids.users.admin.id, ids.users.a.id, ids.users.b.id].map((id) => loadViewer(db(), id)))) as Viewer[];
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  session.current = null;
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const asUser = (v: Viewer) => void (session.current = { viewer: v, user: { id: v.userId }, csrf: "csrf-token" });
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(`${ORIGIN}${path}`, { ...init, headers: { host: HOST, ...(init.headers ?? {}) } });

/** The answer as an object; plain-text answers (a 404) give {}. */
async function readJson(res: Response): Promise<Record<string, any>> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return {};
  }
}
async function register(body: Record<string, unknown> = { client_name: "Claude", redirect_uris: [REDIRECT] }) {
  const { POST } = await import("@/app/api/oauth/register/route");
  const res = await POST(req("/api/oauth/register", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { res, json: await readJson(res) };
}
async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/oauth/token/route");
  const res = await POST(req("/api/oauth/token", { method: "POST", body: new URLSearchParams(params), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }));
  return { res, json: await readJson(res) };
}
async function mcp(secret: string, method: string, params?: unknown) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(req("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" } }));
  return { status: res.status, headers: res.headers, json: res.status === 200 ? ((await res.json()) as Record<string, any>) : null };
}
const tool = async (secret: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp(secret, "tools/call", { name, arguments: args });
  return r.status === 200 ? { isError: !!r.json!.result.isError, data: JSON.parse(r.json!.result.content[0].text) } : { status: r.status };
};

/** Consent given through the real server action; returns the address the browser is sent to. */
async function consent(v: Viewer, o: { clientId: string; challenge: string; workspace?: string; scope?: string; state?: string; redirect?: string; decision?: string; csrf?: string }) {
  const { decideOAuthAction } = await import("@/app/oauth-actions");
  asUser(v);
  const fd = new FormData();
  fd.set("csrf", o.csrf ?? "csrf-token");
  fd.set("client_id", o.clientId);
  fd.set("redirect_uri", o.redirect ?? REDIRECT);
  fd.set("code_challenge", o.challenge);
  fd.set("resource", MCP);
  if (o.state !== undefined) fd.set("state", o.state);
  fd.set("workspace", o.workspace ?? v.workspaceId);
  fd.set("scope", o.scope ?? "READ");
  fd.set("decision", o.decision ?? "approve");
  return decideOAuthAction(fd);
}
const codeOf = (r: Awaited<ReturnType<typeof consent>>) => {
  if (!r.ok) throw new Error(`consent failed: ${r.error}`);
  return new URL(String(r.data!.redirect)).searchParams.get("code")!;
};

/** The whole dance: register, consent, exchange. */
async function connect(v: Viewer, scope: "READ" | "WRITE" = "READ", workspace?: string) {
  const { json: c } = await register();
  const { verifier, challenge } = pkce();
  const code = codeOf(await consent(v, { clientId: c.client_id, challenge, scope, workspace }));
  const t = await token({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP });
  return { clientId: c.client_id as string, tokens: t.json, status: t.res.status, verifier, challenge, code };
}

describe("metadata", () => {
  it("serves protected resource and authorization server metadata, hosted only", async () => {
    const pr = await import("@/app/.well-known/oauth-protected-resource/[[...rest]]/route");
    for (const rest of [undefined, ["api", "mcp"]]) {
      const r = await pr.GET(req("/.well-known/oauth-protected-resource"), { params: Promise.resolve({ rest }) });
      expect(await r.json()).toMatchObject({ resource: MCP, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
    }
    expect((await pr.GET(req("/x"), { params: Promise.resolve({ rest: ["api", "other"] }) })).status).toBe(404);
    const as = await import("@/app/.well-known/oauth-authorization-server/route");
    expect(await (await as.GET()).json()).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
    });
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await as.GET()).status).toBe(404);
    expect((await pr.GET(req("/x"), { params: Promise.resolve({}) })).status).toBe(404);
    expect((await register()).res.status).toBe(404);
    expect((await token({ grant_type: "refresh_token" })).res.status).toBe(404);
  });

  it("a 401 from /api/mcp points at the metadata", async () => {
    const r = await mcp("mp_oat_" + "z".repeat(43), "ping");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer realm="Mergeport", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  });
});

describe("registration", () => {
  it("registers a public client and echoes what it stored, never a secret", async () => {
    const { res, json } = await register({ client_name: "  Claude  ", redirect_uris: [REDIRECT, "http://localhost:6274/cb", "http://127.0.0.1:1/x", "http://[::1]:9/y", REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [REDIRECT, "http://localhost:6274/cb", "http://127.0.0.1:1/x", "http://[::1]:9/y"] });
    expect(json.client_secret).toBeUndefined();
    expect(await db().oAuthClient.count()).toBe(1);
  });

  it("refuses unsafe redirect addresses and non-public clients", async () => {
    for (const uri of ["http://evil.example/cb", "http://localhost.evil.example/cb", "myapp://cb", "javascript:alert(1)", "https://*.example.com/cb", "https://x.example/cb#frag", "https://user:pw@x.example/cb", "https://x.example/cb\\..", "ftp://x.example/", "/relative", "", "https://x.example/ cb", "data:text/html,hi"]) {
      expect(validRedirectUri(uri), uri).toBe(false);
      await db().rateLimitState.deleteMany({}); // each refusal counts against the address limit
      const { res, json } = await register({ client_name: "X", redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
      expect(json.error).toBe("invalid_redirect_uri");
    }
    await db().rateLimitState.deleteMany({});
    expect((await register({ client_name: "X", redirect_uris: [] })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "X", redirect_uris: Array(6).fill(REDIRECT).map((u, i) => `${u}${i}`) })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "", redirect_uris: [REDIRECT] })).json.error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "x".repeat(81), redirect_uris: [REDIRECT] })).json.error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "a\u0007b", redirect_uris: [REDIRECT] })).json.error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "X", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).json.error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "X", redirect_uris: [REDIRECT], grant_types: ["password"] })).json.error).toBe("invalid_client_metadata");
    const { POST } = await import("@/app/api/oauth/register/route");
    expect((await POST(req("/api/oauth/register", { method: "POST", body: "client_name=x", headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(400);
    expect(await db().oAuthClient.count()).toBe(0);
  });

  it("limits registrations per address and caps the table (forgetting apps never used)", async () => {
    for (let i = 0; i < 10; i++) expect((await register()).res.status).toBe(201);
    const over = await register();
    expect(over.res.status).toBe(429);
    expect(over.res.headers.get("retry-after")).toBe("3600");
    await db().rateLimitState.deleteMany({});
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db().oAuthClient.createMany({ data: Array.from({ length: MAX_CLIENTS }, (_, i) => ({ id: `old${i}`, name: "old", redirectUris: [REDIRECT], createdAt: old })) });
    await db().oAuthGrant.create({ data: { workspaceId: a.workspaceId, userId: a.userId, clientId: "old0", resource: MCP } }); // one has a grant
    expect((await register()).res.status).toBe(201); // pruned the unused old ones
    expect(await db().oAuthClient.findUnique({ where: { id: "old0" } })).toBeTruthy();
    expect(await db().oAuthClient.findUnique({ where: { id: "old1" } })).toBeNull();
    await db().oAuthClient.createMany({ data: Array.from({ length: MAX_CLIENTS }, (_, i) => ({ id: `new${i}`, name: "new", redirectUris: [REDIRECT] })) });
    await db().rateLimitState.deleteMany({});
    const full = await register();
    expect(full.res.status).toBe(503);
  });
});

describe("authorization request", () => {
  const base = async () => {
    const { json: c } = await register();
    return { client_id: c.client_id as string, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "xyz" };
  };

  it("accepts a good request and echoes state, defaulting the resource to this server", async () => {
    const q = await base();
    const r = await parseAuthorize(db(), q);
    expect(r).toMatchObject({ ok: true, request: { clientName: "Claude", redirectUri: REDIRECT, state: "xyz", resource: MCP, wantsWrite: false } });
    expect(await parseAuthorize(db(), { ...q, scope: "read write", resource: MCP })).toMatchObject({ ok: true, request: { wantsWrite: true } });
  });

  it("never redirects to an address that is not exactly registered, or for an unknown app", async () => {
    const q = await base();
    for (const redirect_uri of [REDIRECT + "/", REDIRECT + "?a=b", REDIRECT.toUpperCase(), "https://claude.example/api/mcp/auth_callbac", "https://evil.example/cb", "http://claude.example/api/mcp/auth_callback", undefined, ""]) {
      expect(await parseAuthorize(db(), { ...q, redirect_uri }), String(redirect_uri)).toMatchObject({ ok: false, fatal: true });
    }
    expect(await parseAuthorize(db(), { ...q, client_id: "nope" })).toMatchObject({ ok: false, fatal: true });
    expect(await parseAuthorize(db(), { ...q, client_id: undefined })).toMatchObject({ ok: false, fatal: true });
    expect(await parseAuthorize(db(), { ...q, state: "x".repeat(513) })).toMatchObject({ ok: false, fatal: true });
    expect(await parseAuthorize(db(), { ...q, state: "a\nb" })).toMatchObject({ ok: false, fatal: true });
  });

  it("requires PKCE S256, response_type code and this server's resource, answering to the registered address with the state", async () => {
    const q = await base();
    const bad = (o: Record<string, unknown>) => parseAuthorize(db(), { ...q, ...o });
    expect(await bad({ code_challenge: undefined })).toMatchObject({ ok: false, fatal: false, error: "invalid_request", state: "xyz", redirectUri: REDIRECT });
    expect(await bad({ code_challenge_method: "plain" })).toMatchObject({ error: "invalid_request" });
    expect(await bad({ code_challenge_method: undefined })).toMatchObject({ error: "invalid_request" });
    expect(await bad({ code_challenge: "short" })).toMatchObject({ error: "invalid_request" });
    expect(await bad({ response_type: "token" })).toMatchObject({ error: "unsupported_response_type" });
    expect(await bad({ resource: "https://other.example/api/mcp" })).toMatchObject({ error: "invalid_target" });
  });
});

describe("the flow", () => {
  it("registers, consents, exchanges, calls the MCP endpoint, and refreshes", async () => {
    const c = await connect(a, "WRITE");
    expect(c.status).toBe(200);
    expect(c.tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "write" });
    expect(c.tokens.access_token).toMatch(/^mp_oat_[A-Za-z0-9_-]{43}$/);
    expect(c.tokens.refresh_token).toMatch(/^mp_ort_[A-Za-z0-9_-]{43}$/);
    const access = await db().apiToken.findFirstOrThrow({ where: { tokenHash: sha256(c.tokens.access_token) } });
    expect(access).toMatchObject({ kind: "OAUTH", scope: "WRITE", userId: a.userId, workspaceId: a.workspaceId, audience: MCP, name: "Claude" });
    expect(access.expiresAt!.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    expect(access.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(JSON.stringify(await db().oAuthRefresh.findMany())).not.toContain(c.tokens.refresh_token); // hash only

    expect(((await tool(c.tokens.access_token, "list_projects")) as { data: { projects: unknown[] } }).data.projects).toHaveLength(2);
    const made = (await tool(c.tokens.access_token, "create_task", { project: "Atlas", title: "Made over OAuth" })) as { isError: boolean; data: { task: { id: string } } };
    expect(made.isError).toBe(false);
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: "mcp.task.create" } });
    expect(audit).toMatchObject({ actorUserId: a.userId, targetId: made.data.task.id });
    expect(audit.meta).toMatchObject({ tokenId: access.id });
    expect(await db().auditLog.count({ where: { action: "oauth.authorize" } })).toBe(1);

    const r = await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId });
    expect(r.res.status).toBe(200);
    expect(r.json.access_token).not.toBe(c.tokens.access_token);
    expect(r.json.refresh_token).not.toBe(c.tokens.refresh_token);
    expect((await tool(r.json.access_token, "list_projects")) as object).toHaveProperty("isError", false);
    expect(await db().oAuthGrant.count()).toBe(1); // the same grant (family)
    expect(r.res.headers.get("cache-control")).toBe("no-store");
  });

  it("echoes state in the redirect, and a denial answers access_denied", async () => {
    const { json: c } = await register();
    const { challenge } = pkce();
    const ok = await consent(a, { clientId: c.client_id, challenge, state: "s t&=" });
    const u = new URL(String(ok.ok && ok.data!.redirect));
    expect(`${u.origin}${u.pathname}`).toBe(REDIRECT);
    expect(u.searchParams.get("state")).toBe("s t&=");
    const no = await consent(a, { clientId: c.client_id, challenge, state: "abc", decision: "deny" });
    const d = new URL(String(no.ok && no.data!.redirect));
    expect(d.searchParams.get("error")).toBe("access_denied");
    expect(d.searchParams.get("state")).toBe("abc");
    expect(d.searchParams.get("code")).toBeNull();
    expect(await db().oAuthCode.count()).toBe(1); // only the approval made a code
  });

  it("checks the session's CSRF token and re-validates the request the form carried", async () => {
    const { json: c } = await register();
    const { challenge } = pkce();
    const bad = await consent(a, { clientId: c.client_id, challenge, csrf: "forged" });
    expect(bad.ok).toBe(false);
    expect((await consent(a, { clientId: c.client_id, challenge, redirect: "https://evil.example/cb" })).ok).toBe(false);
    expect((await consent(a, { clientId: "nope", challenge })).ok).toBe(false);
    expect((await consent(a, { clientId: c.client_id, challenge: "short" })).ok).toBe(false);
    expect(await db().oAuthCode.count()).toBe(0);
  });

  it("PAT bearer auth keeps working beside OAuth, and PAT lists do not show OAuth tokens", async () => {
    const pat = await createApiToken(db(), a, { name: "mine", scope: "READ" });
    await connect(a);
    expect(((await tool(pat.secret, "list_projects")) as { isError: boolean }).isError).toBe(false);
    expect((await listApiTokens(db(), a)).map((t) => t.name)).toEqual(["mine"]);
    expect((await listApiTokens(db(), admin)).map((t) => t.name)).toEqual(["mine"]);
  });
});

describe("the token endpoint", () => {
  it("a wrong PKCE verifier fails and burns the code", async () => {
    const { json: c } = await register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await consent(a, { clientId: c.client_id, challenge }));
    const params = { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: REDIRECT };
    const wrong = await token({ ...params, code_verifier: pkce().verifier });
    expect(wrong.res.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    expect((await token({ ...params, code_verifier: verifier })).json.error).toBe("invalid_grant"); // the right one is too late
    expect((await token({ ...params, code_verifier: "short" })).json.error).toBe("invalid_grant");
    expect(await db().apiToken.count({ where: { kind: "OAUTH" } })).toBe(0);
  });

  it("a code works once; replaying it revokes what it bought", async () => {
    const c = await connect(a, "WRITE");
    expect(c.status).toBe(200);
    expect((await tool(c.tokens.access_token, "list_projects")) as object).toHaveProperty("isError", false);
    const again = await token({ grant_type: "authorization_code", code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, code_verifier: c.verifier });
    expect(again.json.error).toBe("invalid_grant");
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId })).json.error).toBe("invalid_grant");
    expect(await db().auditLog.count({ where: { action: "oauth.code-replay" } })).toBe(1);
  });

  it("an expired code, a wrong client and a wrong redirect address all fail", async () => {
    const { json: c } = await register();
    const { json: other } = await register({ client_name: "Other", redirect_uris: [REDIRECT] });
    const go = async (mutate: (code: string, v: string) => Promise<Record<string, string>>) => {
      const { verifier, challenge } = pkce();
      const code = codeOf(await consent(a, { clientId: c.client_id, challenge }));
      return (await token({ grant_type: "authorization_code", ...(await mutate(code, verifier)) })).json.error;
    };
    const good = (code: string, v: string) => ({ code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: v });
    expect(await go(async (code, v) => good(code, v))).toBeUndefined(); // control: it works
    expect(await go(async (code, v) => { await db().oAuthCode.updateMany({ where: { codeHash: sha256(code) }, data: { expiresAt: new Date(Date.now() - 1000) } }); return good(code, v); })).toBe("invalid_grant");
    expect(await go(async (code, v) => ({ ...good(code, v), client_id: other.client_id }))).toBe("invalid_grant");
    expect(await go(async (code, v) => ({ ...good(code, v), redirect_uri: REDIRECT + "/" }))).toBe("invalid_grant");
    expect(await go(async (code, v) => ({ ...good(code, v), resource: "https://other.example/api/mcp" }))).toBe("invalid_target");
    expect(await go(async () => ({ code: "mp_oac_" + "q".repeat(43), client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: "v".repeat(43) }))).toBe("invalid_grant");
  });

  it("rejects malformed requests and unsupported grants", async () => {
    expect((await token({ grant_type: "password", client_id: "x" })).json.error).toBe("unsupported_grant_type");
    expect((await token({ grant_type: "authorization_code" })).json.error).toBe("invalid_client");
    expect((await token({ grant_type: "authorization_code", client_id: "x" })).json.error).toBe("invalid_request");
    expect((await token({ grant_type: "refresh_token", client_id: "x" })).json.error).toBe("invalid_request");
    const { POST } = await import("@/app/api/oauth/token/route");
    expect((await POST(req("/api/oauth/token", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(400);
    expect((await POST(req("/api/oauth/token", { method: "POST", body: "x".repeat(20_000), headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(400);
  });

  it("rotates refresh tokens; reusing an old one revokes the whole family, including the newest tokens", async () => {
    const c = await connect(a, "WRITE");
    const r1 = await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId });
    expect(r1.res.status).toBe(200);
    const stolen = await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId }); // the old one again
    expect(stolen.json.error).toBe("invalid_grant");
    expect(((await tool(r1.json.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: c.clientId })).json.error).toBe("invalid_grant");
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect((await listGrants(db(), a))).toEqual([]);
    expect(await db().auditLog.count({ where: { action: "oauth.refresh-reuse" } })).toBe(1);
  });

  it("a refresh token needs its own client, and expired ones do not work", async () => {
    const c = await connect(a);
    const { json: other } = await register({ client_name: "Other", redirect_uris: [REDIRECT] });
    expect((await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: other.client_id })).json.error).toBe("invalid_grant");
    expect((await token({ grant_type: "refresh_token", refresh_token: "mp_ort_" + "n".repeat(43), client_id: c.clientId })).json.error).toBe("invalid_grant");
    await db().oAuthRefresh.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId })).json.error).toBe("invalid_grant");
  });

  it("limits requests per address and per client", async () => {
    const future = new Date(Date.now() + 60_000);
    const full = (key: string) => db().rateLimitState.upsert({ where: { key }, create: { key, remaining: 0, limit: 1, resetAt: future }, update: { remaining: 0, resetAt: future } });
    await full("oauth:tok:c:clientx");
    const r = await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "clientx" });
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get("retry-after")).toBe("60");
    expect((await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "other" })).res.status).toBe(400); // another client is unaffected
    const { addressBucket } = await import("@/lib/oauth-http");
    await full(addressBucket("tok", req("/api/oauth/token")));
    expect((await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "other" })).res.status).toBe(429);
  });
});

describe("what an OAuth token is allowed", () => {
  it("is bound to the workspace chosen at consent, and a workspace you are not in cannot be chosen", async () => {
    const other = await workspaceWithOwner(db(), "other-owner@example.com", "Other");
    await db().member.create({ data: { workspaceId: other.ws.id, userId: a.userId, role: "MEMBER" } });
    await db().project.create({ data: { workspaceId: other.ws.id, name: "Zeta secret", slug: "zeta" } });
    const demo = await connect(a);
    expect(JSON.stringify(await tool(demo.tokens.access_token, "list_projects"))).not.toContain("Zeta");
    const { json: c } = await register();
    const { challenge } = pkce();
    const notMine = await consent(b, { clientId: c.client_id, challenge, workspace: other.ws.id });
    expect(notMine.ok).toBe(false);
    expect(await db().oAuthCode.count({ where: { userId: b.userId } })).toBe(0);
    // an owner of the other workspace gets a token that sees nothing of this one
    const theirs = await connect(other.viewer);
    const projects = ((await tool(theirs.tokens.access_token, "list_projects")) as { data: { projects: { name: string }[] } }).data.projects;
    expect(projects.map((p) => p.name)).toEqual(["Zeta secret"]);
    expect(((await tool(theirs.tokens.access_token, "create_task", { project: ids.projects.atlas.id, title: "Across" })) as { isError: boolean }).isError).toBe(true);
    expect(await db().planningItem.count({ where: { title: "Across" } })).toBe(0);
  });

  it("caps write access by role, at consent and later", async () => {
    const reader = await addMember(db(), a.workspaceId, "reader@example.com", "READER");
    const rv = await reader.viewer();
    const { json: c } = await register();
    const { challenge } = pkce();
    const denied = await consent(rv, { clientId: c.client_id, challenge, scope: "WRITE" });
    expect(denied.ok).toBe(false);
    expect(denied.ok ? "" : denied.error).toMatch(/read-only/);
    await expect(issueCode(db(), rv.userId, { workspaceId: rv.workspaceId, scope: "WRITE", request: { clientId: c.client_id, clientName: "Claude", redirectUri: REDIRECT, codeChallenge: challenge, resource: MCP, wantsWrite: true } })).rejects.toBeInstanceOf(ValidationError);
    expect((await consent(rv, { clientId: c.client_id, challenge, scope: "READ" })).ok).toBe(true);
    expect((await consent(a, { clientId: c.client_id, challenge, scope: "ADMIN" })).ok).toBe(false);

    // a member with write access is demoted after consenting: the token stays but cannot write, and a refresh comes back read-only
    const w = await connect(b, "WRITE");
    expect(w.tokens.scope).toBe("write");
    expect(((await tool(w.tokens.access_token, "create_task", { project: "Dashboard", title: "Before demotion" })) as { isError: boolean }).isError).toBe(false);
    await changeRole(db(), admin, ids.members.b.id, "READER");
    expect(((await tool(w.tokens.access_token, "create_task", { project: "Dashboard", title: "After demotion" })) as { isError: boolean }).isError).toBe(true);
    expect(await db().planningItem.count({ where: { title: "After demotion" } })).toBe(0);
    const r = await token({ grant_type: "refresh_token", refresh_token: w.tokens.refresh_token, client_id: w.clientId });
    expect(r.json.scope).toBe("read");
  });

  it("dies with the membership: a removed member's access and refresh tokens stop", async () => {
    const c = await connect(a);
    await removeMember(db(), admin, ids.members.a.id);
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId })).json.error).toBe("invalid_grant");
    expect(await db().oAuthGrant.count({ where: { revokedAt: { not: null } } })).toBe(1);
  });

  it("is refused when expired or bound to another audience", async () => {
    const c = await connect(a);
    const row = () => db().apiToken.findFirstOrThrow({ where: { tokenHash: sha256(c.tokens.access_token) } });
    await db().apiToken.update({ where: { id: (await row()).id }, data: { audience: "https://other.example/api/mcp" } });
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    await db().apiToken.update({ where: { id: (await row()).id }, data: { audience: MCP, expiresAt: new Date(Date.now() - 1000) } });
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    await db().apiToken.update({ where: { id: (await row()).id }, data: { expiresAt: new Date(Date.now() + 60_000), audience: null } });
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
  });
});

describe("connected apps", () => {
  it("lists your own, lets an administrator see all, and revoking ends tokens and refresh tokens", async () => {
    const mine = await connect(a, "WRITE");
    const theirs = await connect(b);
    expect((await listGrants(db(), a)).map((g) => [g.clientName, g.scope, g.mine])).toEqual([["Claude", "WRITE", true]]);
    expect((await listGrants(db(), admin)).map((g) => g.mine)).toEqual([false, false]);
    const [g] = await listGrants(db(), a);
    await expect(revokeGrant(db(), b, g.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeGrant(db(), b, "nope")).rejects.toBeInstanceOf(NotFoundError);
    await revokeGrant(db(), a, g.id);
    await expect(revokeGrant(db(), a, g.id)).resolves.toBeUndefined(); // safe to repeat
    expect(((await tool(mine.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: mine.tokens.refresh_token, client_id: mine.clientId })).json.error).toBe("invalid_grant");
    expect(((await tool(theirs.tokens.access_token, "list_projects")) as { isError: boolean }).isError).toBe(false); // another person's app is untouched
    const [bg] = await listGrants(db(), admin);
    await revokeGrant(db(), admin, bg.id); // an administrator may
    expect(((await tool(theirs.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    expect(await db().auditLog.count({ where: { action: "oauth.revoke" } })).toBe(2);
    expect(await listGrants(db(), admin)).toEqual([]);
  });

  it("revokes through the server action", async () => {
    const c = await connect(a);
    const { revokeOAuthGrantAction } = await import("@/app/oauth-actions");
    asUser(a);
    const [g] = await listGrants(db(), a);
    const fd = new FormData();
    fd.set("id", g.id);
    expect((await revokeOAuthGrantAction(fd)).ok).toBe(true);
    expect(((await tool(c.tokens.access_token, "list_projects")) as { status: number }).status).toBe(401);
    asUser(b);
    expect((await revokeOAuthGrantAction(fd)).ok).toBe(false);
  });
});
