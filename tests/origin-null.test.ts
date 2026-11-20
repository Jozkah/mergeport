import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sameOrigin } from "@/lib/http";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const HOST = "app.example.com";
beforeEach(() => {
  vi.stubEnv("MERGEPORT_PUBLIC_URL", `https://${HOST}`);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
});
afterEach(() => vi.unstubAllEnvs());

const post = async (headers: Record<string, string>) => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");
  return proxy(new NextRequest(`https://${HOST}/auth/magic/request`, { method: "POST", headers: { host: HOST, ...headers } }));
};

describe('a same-origin form post from a no-referrer page sends "Origin: null"', () => {
  it("the proxy accepts it only when the browser says Sec-Fetch-Site: same-origin", async () => {
    expect((await post({ origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(200);
    for (const site of ["cross-site", "same-site", "none"]) expect((await post({ origin: "null", "sec-fetch-site": site })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403); // no Sec-Fetch-Site at all
  });

  it("ordinary origins behave as before", async () => {
    expect((await post({ origin: `https://${HOST}` })).status).toBe(200);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
  });

  it("the route-level sameOrigin check agrees", () => {
    const req = (h: Record<string, string>) => new Request(`https://${HOST}/x`, { method: "POST", headers: { host: HOST, ...h } });
    expect(sameOrigin(req({ origin: "null", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ origin: "null", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req({ origin: "null" }))).toBe(false);
  });
});

describe("pages with a POST form keep a real Origin", () => {
  it("the invite page's referrer policy is not no-referrer", async () => {
    const mod = await import("@/app/invite/[token]/page");
    expect((mod.metadata as { referrer?: string }).referrer).toBe("same-origin");
  });
});
