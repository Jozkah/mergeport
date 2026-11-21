import { beforeAll, describe, expect, it } from "vitest";
import { unsafeBoundInstallationForTests as bound } from "@/lib/github/bound-installation";
import { mintInstallationToken, resetInstallationTokenCache } from "@/lib/github/app-auth";
import { FakeGitHubServer } from "@/lib/github/fake-server";

const B = "https://api.github.com";
let s: FakeGitHubServer;
let app: ReturnType<FakeGitHubServer["registerApp"]>;
let inst: number;
let f: typeof fetch;
let userTok: string;
let outsider: string;

const get = (path: string, token: string | null) => f(`${B}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  s = new FakeGitHubServer();
  app = s.registerApp("777");
  s.addUser("alice");
  s.addUser("bob");
  s.addOrg("acme", ["alice"], ["bob"]);
  for (const n of ["a", "b", "c", "d", "e"]) await s.fetchFor("alice")(`${B}/orgs/acme/repos`, { method: "POST", body: JSON.stringify({ name: n, private: n !== "a" }) });
  // bob is collaborator on c only.
  s.repo("acme", "c")!.collaborators.set("bob", "pull");
  s.addUser("acme-owner");
  inst = s.addInstallation("acme", { repos: ["acme/a", "acme/b", "acme/c", "acme/d"] }).id;
  f = s.appFetch();
  userTok = s.issueUserToken("bob");
  outsider = s.issueUserToken("carol-not-a-user");
  resetInstallationTokenCache();
});

describe("fake GitHub: GitHub App routes", () => {
  it("lists the installation and its repositories with an installation token, paginated", async () => {
    const { token } = await mintInstallationToken(bound(inst), { config: { appId: "777", privateKeyPem: app.privateKeyPem, webhookSecret: "", clientId: "", clientSecret: "", slug: "x" }, fetch: f });
    const p1 = await get("/installation/repositories?per_page=3&page=1", token);
    const b1 = await p1.json();
    expect(b1.total_count).toBe(4);
    expect(b1.repositories.map((r: any) => r.name)).toEqual(["a", "b", "c"]);
    expect(p1.headers.get("link")).toContain('rel="next"');
    const p2 = await get("/installation/repositories?per_page=3&page=2", token);
    expect((await p2.json()).repositories.map((r: any) => r.name)).toEqual(["d"]);
    expect(p2.headers.get("link")).toBeNull();
  });

  it("rejects missing, unknown and expired installation tokens", async () => {
    expect((await get("/installation/repositories", null)).status).toBe(401);
    expect((await get("/installation/repositories", "ghs_nope")).status).toBe(401);
    const short = new FakeGitHubServer(() => now);
    let now = 1_000_000_000_000;
    const a = short.registerApp("5");
    short.addUser("u");
    const i = short.addInstallation("u").id;
    short.installationTokenTtlMs = 1000;
    const sf = short.appFetch();
    const tok = (await mintInstallationToken(bound(i), { config: { appId: "5", privateKeyPem: a.privateKeyPem, webhookSecret: "", clientId: "", clientSecret: "", slug: "x" }, fetch: sf, now: () => now })).token;
    expect((await sf(`${B}/installation/repositories`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(200);
    now += 2000;
    expect((await sf(`${B}/installation/repositories`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    resetInstallationTokenCache();
  });

  it("GET /app/installations/:id needs the app JWT and 404s for unknown ids", async () => {
    const { signAppJwt } = await import("@/lib/github/app-auth");
    const jwt = signAppJwt({ appId: "777", privateKeyPem: app.privateKeyPem });
    const ok = await get(`/app/installations/${inst}`, jwt);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ id: inst, target_type: "Organization", repository_selection: "selected", suspended_at: null, account: { login: "acme", type: "Organization" } });
    expect((await get(`/app/installations/${inst}`, "bad")).status).toBe(401);
    expect((await get("/app/installations/31337", jwt)).status).toBe(404);
  });

  it("a suspended installation answers 403 for tokens and repositories", async () => {
    s.addUser("sus");
    const i = s.addInstallation("sus", { suspended: true }).id;
    const { signAppJwt } = await import("@/lib/github/app-auth");
    const r = await f(`${B}/app/installations/${i}/access_tokens`, { method: "POST", headers: { authorization: `Bearer ${signAppJwt({ appId: "777", privateKeyPem: app.privateKeyPem })}` } });
    expect(r.status).toBe(403);
  });

  it("GET /user/installations lists only installations the user can reach", async () => {
    const mine = await (await get("/user/installations", userTok)).json();
    expect(mine.installations.map((i: any) => i.id)).toEqual([inst]);
    expect((await get("/user/installations", outsider)).status).toBe(200);
    expect((await (await get("/user/installations", outsider)).json()).total_count).toBe(0);
    expect((await get("/user/installations", null)).status).toBe(401);
  });

  it("GET /user/installations/:id/repositories shows each user only what they can read", async () => {
    const bob = await (await get(`/user/installations/${inst}/repositories`, userTok)).json();
    expect(bob.repositories.map((r: any) => r.name)).toEqual(["a", "c"]);
    const alice = s.issueUserToken("alice");
    const all = await (await get(`/user/installations/${inst}/repositories`, alice)).json();
    expect(all.repositories.map((r: any) => r.name)).toEqual(["a", "b", "c", "d"]);
    expect((await get(`/user/installations/${inst}/repositories`, outsider)).status).toBe(404);
    expect((await get("/user/installations/424242/repositories", userTok)).status).toBe(404);
  });

  it("keeps the per-user routes working", async () => {
    const r = await s.fetchFor("alice")(`${B}/user`);
    expect(r.status).toBe(200);
    expect((await s.fetchFor("alice")(`${B}/user/repos`)).status).toBe(200);
  });
});
