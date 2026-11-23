import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { githubApiBase } from "@/lib/github/app-auth";
import { githubWebBase, oauthAuthorizeUrl } from "@/lib/github/connect-api";

const fake = "http://127.0.0.1:4010";

describe("web base (the local fake GitHub's pages)", () => {
  it("is github.com by default and is overridable only in test and development, and only for loopback", () => {
    expect(githubWebBase({})).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: fake })).toBe("https://github.com"); // NODE_ENV unset
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: fake, NODE_ENV: "production" })).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: fake, NODE_ENV: "staging" })).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: fake + "/", NODE_ENV: "development" })).toBe(fake);
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "http://localhost:4010", NODE_ENV: "test" })).toBe("http://localhost:4010");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "https://ghe.example.com", NODE_ENV: "development" })).toBe("https://github.com"); // not loopback
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "http://evil.example.com", NODE_ENV: "development" })).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "http://user:pw@127.0.0.1:4010", NODE_ENV: "development" })).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "ftp://127.0.0.1", NODE_ENV: "development" })).toBe("https://github.com");
    expect(githubWebBase({ MERGEPORT_GITHUB_WEB_BASE: "not a url", NODE_ENV: "development" })).toBe("https://github.com");
  });

  describe("process environment", () => {
    afterEach(() => vi.unstubAllEnvs());
    const authorize = () => oauthAuthorizeUrl({ clientId: "Iv1.0123456789abcdef" }, { redirectUri: "http://127.0.0.1:3100/cb", state: "s", nonce: "n" });

    it("the authorize address uses the override in development and github.com in production", () => {
      vi.stubEnv("MERGEPORT_GITHUB_WEB_BASE", fake);
      vi.stubEnv("NODE_ENV", "development");
      expect(authorize().startsWith(`${fake}/login/oauth/authorize?`)).toBe(true);
      vi.stubEnv("NODE_ENV", "production");
      expect(authorize().startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    });

    it("production ignores both overrides", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MERGEPORT_GITHUB_API_BASE", fake);
      vi.stubEnv("MERGEPORT_GITHUB_WEB_BASE", fake);
      expect(githubApiBase()).toBe("https://api.github.com");
      expect(githubWebBase()).toBe("https://github.com");
    });
  });
});

describe("hosted startup and the GitHub address overrides", () => {
  afterEach(() => vi.unstubAllEnvs());
  const hosted = (nodeEnv: string | undefined) => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "http://127.0.0.1:3100");
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
    for (const k of ["MERGEPORT_GITHUB_APP_ID", "MERGEPORT_GITHUB_APP_PRIVATE_KEY", "MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE", "MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "MERGEPORT_GITHUB_APP_CLIENT_ID", "MERGEPORT_GITHUB_APP_CLIENT_SECRET", "MERGEPORT_GITHUB_APP_SLUG"]) vi.stubEnv(k, "");
    vi.stubEnv("NODE_ENV", nodeEnv as string);
    vi.stubEnv("MERGEPORT_GITHUB_API_BASE", fake);
    vi.stubEnv("MERGEPORT_GITHUB_WEB_BASE", fake);
  };

  it.each(["production", "test", "staging"])("refuses both overrides on a hosted deployment with NODE_ENV=%s", (nodeEnv) => {
    hosted(nodeEnv);
    const p = hostedConfigProblems().join("\n");
    expect(p).toContain("MERGEPORT_GITHUB_API_BASE");
    expect(p).toContain("MERGEPORT_GITHUB_WEB_BASE");
    expect(p).not.toContain("4010");
  });

  it("allows both in a local hosted-mode development run (NODE_ENV=development)", () => {
    hosted("development");
    expect(hostedConfigProblems()).toEqual([]);
  });

  it("each override alone is refused in production", () => {
    hosted("production");
    vi.stubEnv("MERGEPORT_GITHUB_API_BASE", "");
    expect(hostedConfigProblems().join()).toContain("MERGEPORT_GITHUB_WEB_BASE");
    vi.stubEnv("MERGEPORT_GITHUB_API_BASE", fake);
    vi.stubEnv("MERGEPORT_GITHUB_WEB_BASE", "");
    expect(hostedConfigProblems().join()).toContain("MERGEPORT_GITHUB_API_BASE");
  });
});
