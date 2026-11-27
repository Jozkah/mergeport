import { describe, expect, it } from "vitest";
import config from "../next.config";
import { buildCsp, newNonce } from "@/lib/csp";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

const parse = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("Content-Security-Policy", () => {
  const nonce = newNonce();
  const d = parse(buildCsp(nonce, false));

  it("nonceFromCsp reads back the script nonce, and nothing from a missing or nonce-less policy", async () => {
    const { nonceFromCsp } = await import("@/lib/csp");
    expect(nonceFromCsp(buildCsp(nonce, false))).toBe(nonce);
    expect(nonceFromCsp(null)).toBeUndefined();
    expect(nonceFromCsp("default-src 'self'")).toBeUndefined();
  });

  it("form-action allows only the manifest paths on github.com, never github.com as a whole", () => {
    const sources = d["form-action"];
    expect(sources).toEqual(["'self'", "https://github.com/settings/apps/new", "https://github.com/organizations/"]);
    expect(sources).not.toContain("https://github.com");
    expect(sources.some((s) => /^https:\/\/github\.com\/?$/.test(s) || s.includes("*"))).toBe(false);
  });

  it("locks framing, base, plugins and scripts", () => {
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["img-src"]).toEqual(["'self'", "data:", "https://github.com", "https://*.githubusercontent.com"]);
  });

  it("allows unsafe-eval only in development, never unsafe-inline for scripts", () => {
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(parse(buildCsp(nonce, true))["script-src"]).toContain("'unsafe-eval'");
  });

  it("proxy sends it on the response with a fresh nonce each time, and passes it to Next on the request", () => {
    const get = () => proxy(new NextRequest("http://127.0.0.1:3000/", { headers: { host: "127.0.0.1:3000" } }));
    const a = get().headers.get("Content-Security-Policy")!;
    const b = get().headers.get("Content-Security-Policy")!;
    expect(parse(a)["script-src"]).toContain("'strict-dynamic'");
    expect(a).not.toEqual(b);
    // Next picks the nonce up from the forwarded request headers
    expect(get().headers.get("x-middleware-request-content-security-policy")).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("is not also set statically in next.config (two policies would intersect and block the nonce)", async () => {
    const rules = await config.headers!();
    expect(rules.flatMap((r) => r.headers).some((h) => h.key === "Content-Security-Policy")).toBe(false);
  });
});
