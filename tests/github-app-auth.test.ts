import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppMisconfiguredError, GITHUB_API_BASE, GithubAppError, InstallationGoneError, InstallationSuspendedError, NEGATIVE_TTL_MS, RateLimitedError,
  REFRESH_WITHIN_MS, createInstallationTokenProvider, githubApiBase, mintInstallationToken, resetInstallationTokenCache, signAppJwt,
} from "@/lib/github/app-auth";
import type { GithubAppConfig } from "@/lib/github/app-config";
import { FakeGitHubServer } from "@/lib/github/fake-server";

const T0 = Date.parse("2026-11-23T10:00:00Z");
let t = T0;
const clock = () => t;
let server: FakeGitHubServer;
let config: GithubAppConfig;
let publicKeyPem: string;
let installationId: number;

beforeAll(() => {
  const s = new FakeGitHubServer(clock);
  const app = s.registerApp("424242");
  publicKeyPem = app.publicKeyPem;
  config = { appId: app.appId, privateKeyPem: app.privateKeyPem, webhookSecret: "w".repeat(20), clientId: "Iv1.abcdefgh", clientSecret: "c".repeat(30), slug: "mergeport-test" };
});

beforeEach(() => {
  t = T0;
  resetInstallationTokenCache();
  server = new FakeGitHubServer(clock);
  server.addUser("acme-owner");
  // Reuse the one key pair across tests: a fresh server accepts the same public key.
  (server as any).app = { appId: config.appId, publicKeyPem };
  installationId = server.addInstallation("acme-owner").id;
});
afterEach(() => vi.restoreAllMocks());

const opts = () => ({ config, fetch: server.appFetch(), now: clock });
const decode = (jwt: string) => {
  const [h, b, s] = jwt.split(".");
  return { head: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(b, "base64url").toString()), sig: Buffer.from(s, "base64url"), signed: `${h}.${b}` };
};
const mints = () => server.calls.filter((c) => c.includes("/access_tokens")).length;

describe("app JWT", () => {
  it("is RS256 with iat = now-60s, exp = iat+9min, iss = app id, and verifies with the public key", () => {
    const { head, claims, sig, signed } = decode(signAppJwt(config, T0));
    expect(head).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iat).toBe(T0 / 1000 - 60);
    expect(claims.exp).toBe(claims.iat + 540);
    expect(claims.iss).toBe("424242");
    expect(verify("RSA-SHA256", Buffer.from(signed), createPublicKey(publicKeyPem), sig)).toBe(true);
    expect(verify("RSA-SHA256", Buffer.from(signed + "x"), createPublicKey(publicKeyPem), sig)).toBe(false);
  });

  it("the fake GitHub accepts it and survives clock skew within the backdate, rejects tampering and a wrong issuer", async () => {
    const f = server.appFetch();
    const post = (jwt: string) => f(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: { authorization: `Bearer ${jwt}` } });
    expect((await post(signAppJwt(config, T0))).status).toBe(201);
    // Our clock 50 s ahead of GitHub: iat (now-60) is still in the past for GitHub.
    expect((await post(signAppJwt(config, T0 + 50_000))).status).toBe(201);
    // Our clock 2 minutes ahead: iat is in GitHub's future and is refused.
    expect((await post(signAppJwt(config, T0 + 120_000))).status).toBe(401);
    // Our clock 10 minutes behind: expired.
    expect((await post(signAppJwt(config, T0 - 600_000))).status).toBe(401);
    expect((await post(signAppJwt({ ...config, appId: "999" }, T0))).status).toBe(401);
    const good = signAppJwt(config, T0).split(".");
    expect((await post(`${good[0]}.${good[1]}.${good[2].slice(0, -4)}AAAA`)).status).toBe(401);
    expect((await post("garbage")).status).toBe(401);
  });

  it("an unusable key is AppMisconfigured and does not leak the key", () => {
    try {
      signAppJwt({ appId: "1", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }, T0);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppMisconfiguredError);
      expect((e as Error).message).not.toContain("AAAA");
    }
  });
});

describe("installation tokens", () => {
  it("mints, then serves from cache", async () => {
    const a = await mintInstallationToken(installationId, opts());
    const b = await mintInstallationToken(installationId, opts());
    expect(a.token).toMatch(/^ghs_/);
    expect(b).toEqual(a);
    expect(a.expiresAt).toBe(T0 + 3_600_000);
    expect(mints()).toBe(1);
  });

  it("refreshes when less than 10 minutes remain, not before", async () => {
    const a = await mintInstallationToken(installationId, opts());
    t = a.expiresAt - REFRESH_WITHIN_MS - 1_000;
    expect((await mintInstallationToken(installationId, opts())).token).toBe(a.token);
    t = a.expiresAt - REFRESH_WITHIN_MS + 1_000;
    const c = await mintInstallationToken(installationId, opts());
    expect(c.token).not.toBe(a.token);
    expect(mints()).toBe(2);
  });

  it("shares one request among concurrent callers", async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => mintInstallationToken(installationId, opts())));
    expect(new Set(all.map((x) => x.token)).size).toBe(1);
    expect(mints()).toBe(1);
  });

  it("caches per installation", async () => {
    server.addUser("other");
    const other = server.addInstallation("other").id;
    const [x, y] = await Promise.all([mintInstallationToken(installationId, opts()), mintInstallationToken(other, opts())]);
    expect(x.token).not.toBe(y.token);
    expect(mints()).toBe(2);
  });

  it("a failed request is not cached as a token and the next caller retries", async () => {
    server.failNext(/access_tokens/, 502, "Bad gateway", 1);
    await expect(mintInstallationToken(installationId, opts())).rejects.toMatchObject({ code: "unavailable" });
    expect((await mintInstallationToken(installationId, opts())).token).toMatch(/^ghs_/);
  });

  it("an uninstalled installation is InstallationGone, and the answer is cached for 60 s", async () => {
    await expect(mintInstallationToken(987654, opts())).rejects.toBeInstanceOf(InstallationGoneError);
    await expect(mintInstallationToken(987654, opts())).rejects.toBeInstanceOf(InstallationGoneError);
    expect(mints()).toBe(1);
    t += NEGATIVE_TTL_MS + 1;
    await expect(mintInstallationToken(987654, opts())).rejects.toBeInstanceOf(InstallationGoneError);
    expect(mints()).toBe(2);
  });

  it("a suspended installation is InstallationSuspended, negatively cached, and recovers after the TTL", async () => {
    server.installations.get(installationId)!.suspended = true;
    await expect(mintInstallationToken(installationId, opts())).rejects.toBeInstanceOf(InstallationSuspendedError);
    server.installations.get(installationId)!.suspended = false; // unsuspended on GitHub, but we remember for a minute
    await expect(mintInstallationToken(installationId, opts())).rejects.toBeInstanceOf(InstallationSuspendedError);
    expect(mints()).toBe(1);
    t += NEGATIVE_TTL_MS + 1;
    expect((await mintInstallationToken(installationId, opts())).token).toMatch(/^ghs_/);
  });

  it("rate limiting is RateLimited with a wait, and is not negatively cached", async () => {
    server.rateLimitedUntil = T0 + 30_000;
    const e = await mintInstallationToken(installationId, opts()).catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfterMs).toBe(30_000);
    server.rateLimitedUntil = null;
    expect((await mintInstallationToken(installationId, opts())).token).toMatch(/^ghs_/);
  });

  it("a rejected app JWT (wrong key) is AppMisconfigured", async () => {
    (server as any).app = { appId: config.appId, publicKeyPem: new FakeGitHubServer().registerApp(config.appId).publicKeyPem };
    await expect(mintInstallationToken(installationId, opts())).rejects.toBeInstanceOf(AppMisconfiguredError);
  });

  it("no configuration is AppMisconfigured; a hostile installation id never reaches the URL", async () => {
    await expect(mintInstallationToken(installationId, { config: null, fetch: server.appFetch(), now: clock })).rejects.toBeInstanceOf(AppMisconfiguredError);
    await expect(mintInstallationToken("1/../../x", opts())).rejects.toBeInstanceOf(AppMisconfiguredError);
    expect(server.calls.some((c) => c.includes(".."))).toBe(false);
  });

  it("a network failure is a redacted 'unavailable' error", async () => {
    server.offline = true;
    const e = await mintInstallationToken(installationId, opts()).catch((x) => x);
    expect(e).toBeInstanceOf(GithubAppError);
    expect(e.code).toBe("unavailable");
  });

  it("a still-valid token is kept when the refresh fails transiently", async () => {
    const a = await mintInstallationToken(installationId, opts());
    t = a.expiresAt - REFRESH_WITHIN_MS + 1_000;
    server.offline = true;
    expect((await mintInstallationToken(installationId, opts())).token).toBe(a.token);
  });

  it("the provider interface delegates", async () => {
    const p = createInstallationTokenProvider(opts());
    expect((await p.getToken(BigInt(installationId))).token).toMatch(/^ghs_/);
  });
});

describe("secrets stay out of errors and logs", () => {
  it("neither the token, the JWT nor the key appears in a thrown message or in console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const seen: string[] = [];
    const tok = await mintInstallationToken(installationId, opts());
    for (const mk of [
      () => { server.installations.get(installationId)!.suspended = true; resetInstallationTokenCache(); return mintInstallationToken(installationId, opts()); },
      () => mintInstallationToken(555, opts()),
      () => { server.rateLimitedUntil = T0 + 5_000; return mintInstallationToken(installationId, { ...opts(), now: () => T0 }); },
      () => mintInstallationToken(installationId, { config: null }),
    ]) {
      resetInstallationTokenCache();
      const e = await mk().catch((x) => x);
      seen.push(String(e?.message), String(e?.stack), JSON.stringify(e));
    }
    const all = seen.join("\n") + spies.map((s) => JSON.stringify(s.mock.calls)).join("\n");
    expect(all).not.toContain(tok.token);
    expect(all).not.toContain("eyJ");
    expect(all).not.toContain("PRIVATE KEY");
    expect(all).not.toContain(config.privateKeyPem.split("\n")[1]);
  });

  it("an error response body is never copied into the message", async () => {
    server.failNext(/access_tokens/, 500, "secret-ghs_abcdefghijklmnopqrstuvwxyz0123456789 internal detail");
    const e = await mintInstallationToken(installationId, opts()).catch((x) => x);
    expect(e.message).not.toContain("secret-ghs_");
    expect(e.message).not.toContain("internal detail");
  });
});

describe("API base", () => {
  it("is the constant by default, overridable outside production, ignored in production", () => {
    expect(githubApiBase({})).toBe("https://api.github.com");
    expect(githubApiBase({ MERGEPORT_GITHUB_API_BASE: "http://127.0.0.1:9999/" })).toBe("http://127.0.0.1:9999");
    expect(githubApiBase({ MERGEPORT_GITHUB_API_BASE: "http://127.0.0.1:9999", NODE_ENV: "test" })).toBe("http://127.0.0.1:9999");
    expect(githubApiBase({ MERGEPORT_GITHUB_API_BASE: "http://127.0.0.1:9999", NODE_ENV: "production" })).toBe("https://api.github.com");
    expect(githubApiBase({ MERGEPORT_GITHUB_API_BASE: "ftp://x" })).toBe("https://api.github.com");
    expect(githubApiBase({ MERGEPORT_GITHUB_API_BASE: "not a url" })).toBe("https://api.github.com");
  });

  it("the mint request goes to the override outside production and to api.github.com in production", async () => {
    const urls: string[] = [];
    const f = server.appFetch();
    const spy = ((i: any, init: any) => (urls.push(String(i)), f(i, init))) as typeof fetch;
    await mintInstallationToken(installationId, { config, fetch: spy, now: clock, env: { MERGEPORT_GITHUB_API_BASE: "http://localhost:4010", NODE_ENV: "development" } });
    resetInstallationTokenCache();
    await mintInstallationToken(installationId, { config, fetch: spy, now: clock, env: { MERGEPORT_GITHUB_API_BASE: "http://localhost:4010", NODE_ENV: "production" } });
    expect(urls[0]).toBe(`http://localhost:4010/app/installations/${installationId}/access_tokens`);
    expect(urls[1]).toBe(`https://api.github.com/app/installations/${installationId}/access_tokens`);
  });
});
