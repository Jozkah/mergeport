import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { redirectTo } from "@/lib/http";
import { THEMES, THEME_COOKIE, parseTheme, themeAttribute, themeCookie } from "@/lib/theme";

const req = (host: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://${host}/api/local/signout`, { method: init.method ?? "GET", headers: { host, ...init.headers } });
const status = (r: Response) => (r.headers.get("x-middleware-next") ? 200 : r.status);

describe("loopback-only guard", () => {
  it("serves loopback names and refuses every other Host (DNS rebinding)", () => {
    for (const h of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "localhost"]) expect(status(proxy(req(h)))).toBe(200);
    for (const h of ["evil.example", "127.0.0.1.evil.example:3000", "localhost.evil.example", "192.168.1.5:3000", "0.0.0.0:3000"]) expect(proxy(req(h)).status).toBe(403);
  });

  it("refuses state-changing requests from another origin or with no same-origin signal", () => {
    const post = (headers: Record<string, string>) => proxy(req("127.0.0.1:3000", { method: "POST", headers }));
    expect(status(post({ origin: "http://127.0.0.1:3000" }))).toBe(200);
    expect(post({ origin: "http://evil.example" }).status).toBe(403);
    expect(post({ origin: "http://localhost:3000" }).status).toBe(403); // a different host name is a different origin
    expect(post({ origin: "null" }).status).toBe(403);
    expect(post({}).status).toBe(403);
    expect(status(post({ "sec-fetch-site": "same-origin" }))).toBe(200);
    expect(post({ "sec-fetch-site": "cross-site" }).status).toBe(403);
  });

  it("never lets responses be cached", () => {
    expect(proxy(req("127.0.0.1:3000")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("redirects", () => {
  it("stay on the host the browser used, so the session cookie and form-action policy still apply", () => {
    const r = redirectTo(new Request("http://localhost:3100/api/local/launch", { headers: { host: "127.0.0.1:3100" } }), "/", 303);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("http://127.0.0.1:3100/");
  });
});

describe("theme preference", () => {
  it("only light and dark are explicit; everything else is system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    for (const v of [undefined, null, "", "system", "DARK", "<script>", "dark; Path=/"]) expect(parseTheme(v as string)).toBe("system");
  });
  it("renders no attribute for system so the OS decides", () => {
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("dark")).toBe("dark");
  });
  it("stores the choice per device in a first-party, same-site cookie", () => {
    for (const t of THEMES) {
      const c = themeCookie(t);
      expect(c.startsWith(`${THEME_COOKIE}=${t};`)).toBe(true);
      expect(c).toMatch(/SameSite=Lax/);
      expect(c).not.toMatch(/Domain=/i);
    }
  });
});
