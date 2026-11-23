import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/github-actions", () => ({ startGithubConnectAction: vi.fn() }));
vi.mock("@/components/forms/ActionForm", () => ({ ActionForm: () => null }));

const ok = (redirect: unknown) => ({ ok: true, data: { redirect } }) as never;

async function load(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  return (await import("@/components/settings/GithubConnectForms")).redirectOf;
}

describe("redirectOf (where the browser may be sent after starting a GitHub flow)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("production opens only https addresses, never http loopback", async () => {
    const redirectOf = await load("production");
    expect(redirectOf(ok("https://github.com/login/oauth/authorize?x=1"))).toBe("https://github.com/login/oauth/authorize?x=1");
    expect(redirectOf(ok("http://127.0.0.1:4010/login/oauth/authorize"))).toBeNull();
    expect(redirectOf(ok("http://localhost:4010/x"))).toBeNull();
    expect(redirectOf(ok("javascript:alert(1)"))).toBeNull();
  });

  it("development also opens http loopback (the local fake GitHub), and nothing else", async () => {
    const redirectOf = await load("development");
    expect(redirectOf(ok("http://127.0.0.1:4010/login/oauth/authorize"))).toBe("http://127.0.0.1:4010/login/oauth/authorize");
    expect(redirectOf(ok("http://localhost:4010/x"))).toBe("http://localhost:4010/x");
    expect(redirectOf(ok("https://github.com/x"))).toBe("https://github.com/x");
    expect(redirectOf(ok("http://evil.example.com/x"))).toBeNull();
    expect(redirectOf(ok("http://127.0.0.1.evil.example.com/x"))).toBeNull();
    expect(redirectOf(ok("http://localhost@evil.example.com/x"))).toBeNull();
    expect(redirectOf(ok(42))).toBeNull();
    expect(redirectOf({ ok: false } as never)).toBeNull();
  });
});
