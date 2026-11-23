import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST, ORIGIN } from "./auth-mocks";

/** The hosted perimeter for /api/mcp (docs/mcp.md): exempt from the browser Origin rule only for a plainly non-browser Bearer POST, and no other path gains that. */
beforeEach(() => {
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => vi.unstubAllEnvs());

const BEARER = { authorization: "Bearer mp_pat_" + "a".repeat(43) };
const at = async (path: string, init: { method?: string; headers?: Record<string, string>; host?: string } = {}) => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");
  const host = init.host ?? HOST;
  return proxy(new NextRequest(`https://${host}${path}`, { method: init.method ?? "POST", headers: { host, ...(init.headers ?? {}) } }));
};
const passes = (r: Response) => r.status !== 403 && r.status !== 404;

describe("proxy and /api/mcp", () => {
  it("lets a Bearer POST with no Origin, Sec-Fetch-Site or Cookie through", async () => {
    expect(passes(await at("/api/mcp", { headers: BEARER }))).toBe(true);
    expect((await at("/api/mcp", { headers: BEARER })).headers.get("cache-control")).toBe("no-store");
  });

  it("refuses everything that could be a browser", async () => {
    expect((await at("/api/mcp")).status).toBe(403); // no Bearer
    expect((await at("/api/mcp", { headers: { authorization: "Basic abc" } })).status).toBe(403);
    expect((await at("/api/mcp", { headers: { ...BEARER, origin: "https://evil.example" } })).status).toBe(403);
    expect((await at("/api/mcp", { headers: { ...BEARER, origin: "null" } })).status).toBe(403);
    expect((await at("/api/mcp", { headers: { ...BEARER, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await at("/api/mcp", { headers: { ...BEARER, "sec-fetch-site": "same-origin" } })).status).toBe(200); // the normal same-origin rule still applies to a browser
    expect((await at("/api/mcp", { headers: { ...BEARER, cookie: "mp_session=x" } })).status).toBe(403);
  });

  it("opens no other path, method or host", async () => {
    for (const p of ["/api/mcp/", "/api/mcp/extra", "/api/ai/tool", "/api/task/x", "/api/backup/restore", "/settings"]) expect((await at(p, { headers: BEARER })).status, p).toBe(403);
    expect(passes(await at("/api/mcp", { method: "GET" }))).toBe(true); // reads were never origin checked
    expect((await at("/api/mcp", { headers: BEARER, host: "127.0.0.1:3000" })).status).toBe(403); // hosted: only the public host
  });

  it("does nothing when the server is not hosted", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await at("/api/mcp", { headers: { ...BEARER, host: "127.0.0.1:3000" }, host: "127.0.0.1:3000" })).status).toBe(403);
  });

  it("sends no CORS headers", async () => {
    const r = await at("/api/mcp", { headers: BEARER });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const o = await at("/api/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(o.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("proxy and the OAuth endpoints", () => {
  const MACHINE = ["/api/oauth/register", "/api/oauth/token"];

  it("lets register and token through for a plainly non-browser POST, no Bearer needed", async () => {
    for (const p of MACHINE) expect(passes(await at(p)), p).toBe(true);
  });

  it("refuses them for anything that could be a browser", async () => {
    for (const p of MACHINE) {
      expect((await at(p, { headers: { origin: "https://evil.example" } })).status, p).toBe(403);
      expect((await at(p, { headers: { origin: "null" } })).status, p).toBe(403);
      expect((await at(p, { headers: { "sec-fetch-site": "cross-site" } })).status, p).toBe(403);
      expect((await at(p, { headers: { cookie: "mp_session=x" } })).status, p).toBe(403);
      expect((await at(p, { headers: { "sec-fetch-site": "same-origin" } })).status, p).toBe(200);
    }
  });

  it("exempts nothing else: not the consent page, its action, other methods' paths or look-alikes", async () => {
    for (const p of ["/oauth/authorize", "/api/oauth", "/api/oauth/", "/api/oauth/token/", "/api/oauth/register/x", "/api/oauth/revoke", "/oauth/token"]) expect((await at(p)).status, p).toBe(403);
    expect((await at("/oauth/authorize", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(passes(await at("/oauth/authorize", { method: "GET" }))).toBe(true);
    expect(passes(await at("/.well-known/oauth-protected-resource/api/mcp", { method: "GET" }))).toBe(true);
    expect(passes(await at("/.well-known/oauth-authorization-server", { method: "GET" }))).toBe(true);
  });

  it("does nothing off the public host or when not hosted, and sends no CORS headers", async () => {
    expect((await at("/api/oauth/token", { host: "127.0.0.1:3000" })).status).toBe(403);
    const r = await at("/api/oauth/token");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await at("/api/oauth/token", { host: "127.0.0.1:3000" })).status).toBe(403);
  });
});

