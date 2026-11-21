import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, formPost, request, state } from "./auth-mocks";

/**
 * A hosted deployment must not expose the local app's sign-in routes, must not accept loopback Host names (a proxy can forward a
 * client's own header), and must never start the server's own `gh` for any workspace.
 */
const spies = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  spies.spawn.mockImplementation(real.spawn);
  spies.execFile.mockImplementation(real.execFile as never);
  return { ...real, default: real, spawn: spies.spawn, execFile: spies.execFile };
});
vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
const db = () => state.db!;

beforeEach(() => {
  state.db = createTestPrisma(`hosted-perimeter-${n++}`);
  state.jar.clear();
  spies.spawn.mockClear();
  spies.execFile.mockClear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const proxyAt = async (host: string, path: string, init: { method?: string; origin?: string } = {}) => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");
  return proxy(new NextRequest(`https://${host}${path}`, { method: init.method ?? "GET", headers: { host, ...(init.origin ? { origin: init.origin } : {}) } }));
};

describe("the proxy in hosted mode", () => {
  const LOCAL_ROUTES = ["/api/local/signin", "/api/local/demo", "/api/local/launch", "/api/local/link", "/api/local/switch", "/api/local/hub/start", "/api/local/hub/poll", "/api/local/hub/check", "/api/local/hub/github-app/start", "/api/local/hub/github-app/callback"];

  it("answers 404 to every /api/local route on the public host (except sign-out and the readiness probe)", async () => {
    for (const p of LOCAL_ROUTES) {
      expect((await proxyAt(HOST, p, { method: "POST", origin: ORIGIN })).status, p).toBe(404);
      expect((await proxyAt(HOST, p)).status, p).toBe(404);
    }
    expect((await proxyAt(HOST, "/api/local/ready")).status).toBe(404);
    expect((await proxyAt(HOST, "/api/local/signout", { method: "POST", origin: ORIGIN })).status).toBe(200);
    expect((await proxyAt(HOST, "/sign-in")).status).toBe(200);
  });

  it("refuses a loopback Host (as a proxy might forward from a client) everywhere except the launcher's readiness probe", async () => {
    for (const p of ["/sign-in", "/", "/api/local/signin", "/api/local/demo", "/auth/magic/request"]) {
      expect((await proxyAt("127.0.0.1:3000", p, { method: p.startsWith("/api") || p.startsWith("/auth") ? "POST" : "GET", origin: "http://127.0.0.1:3000" })).status, p).toBe(403);
    }
    expect((await proxyAt("localhost:3000", "/sign-in")).status).toBe(403);
    expect((await proxyAt("[::1]:3000", "/sign-in")).status).toBe(403);
    expect((await proxyAt("127.0.0.1:3000", "/api/local/ready")).status).toBe(200);
  });

  it("the local app still accepts loopback only and never the public name", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await proxyAt("127.0.0.1:3000", "/sign-in")).status).toBe(200);
    expect((await proxyAt(HOST, "/sign-in")).status).toBe(403);
    expect((await proxyAt("127.0.0.1:3000", "/api/local/signin", { method: "POST", origin: "http://127.0.0.1:3000" })).status).toBe(200);
  });
});

describe("the local routes themselves refuse a hosted request (the proxy is not the only gate)", () => {
  const post = (path: string, extra: Record<string, string> = {}) => formPost(path, { as: "admin" }, extra);

  it("POST /api/local/signin, /demo, /switch and the hub routes: 404, no session, no gh", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const user = await db().user.create({ data: { githubId: 11n, login: "server-owner" } });
    const routes: [string, string][] = [
      ["signin", "@/app/api/local/signin/route"],
      ["demo", "@/app/api/local/demo/route"],
      ["switch", "@/app/api/local/switch/route"],
      ["hub/start", "@/app/api/local/hub/start/route"],
      ["hub/poll", "@/app/api/local/hub/poll/route"],
      ["hub/check", "@/app/api/local/hub/check/route"],
      ["hub/github-app/start", "@/app/api/local/hub/github-app/start/route"],
    ];
    for (const [name, mod] of routes) {
      const res = await (await import(/* @vite-ignore */ mod)).POST(post(`/api/local/${name}`));
      expect(res.status, name).toBe(404);
    }
    expect(await db().session.count({ where: { userId: user.id } })).toBe(0);
    expect(state.jar.size).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it("GET /api/local/launch, /link and the GitHub App callback: 404", async () => {
    for (const mod of ["@/app/api/local/launch/route", "@/app/api/local/link/route", "@/app/api/local/hub/github-app/callback/route"]) {
      const res = await (await import(/* @vite-ignore */ mod)).GET(request("/api/local/x?token=anything"));
      expect(res.status, mod).toBe(404);
    }
    expect(state.jar.size).toBe(0);
  });

  it("POST /api/local/signin needs a loopback Host with the right port even in the local app (a public name is refused)", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const { POST } = await import("@/app/api/local/signin/route");
    expect((await POST(post("/api/local/signin"))).status).toBe(403); // Host: app.test
    expect((await POST(post("/api/local/signin", { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" }))).status).toBe(403); // wrong port
  });

  it("sign-out and the readiness probe keep working", async () => {
    const out = await (await import("@/app/api/local/signout/route")).POST(post("/api/local/signout"));
    expect(out.status).toBe(303);
    const ready = await (await import("@/app/api/local/ready/route")).GET(request("/api/local/ready"));
    expect(ready.status).toBe(403); // Host is the public name, not loopback
  });
});

describe("startLocalSession falls back only to a user with a GitHub id", () => {
  it("a hosted (email) user is never picked as 'the local profile'", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    vi.doMock("@/lib/local/identity", async (orig) => ({ ...(await orig<typeof import("@/lib/local/identity")>()), currentGhStatus: async () => ({ state: "error", message: "network is unreachable" }) }));
    vi.resetModules();
    const { startLocalSession } = await import("@/lib/local/session-routes");
    const emailUser = await db().user.create({ data: { login: "emailer", email: "e@example.com" } });
    expect(await startLocalSession()).toEqual({ ok: false, error: "gh-error" });
    expect(await db().session.count()).toBe(0);
    const gh = await db().user.create({ data: { githubId: 77n, login: "gh-user" } });
    expect(await startLocalSession()).toEqual({ ok: true });
    const s = await db().session.findFirstOrThrow();
    expect(s.userId).toBe(gh.id);
    expect(s.userId).not.toBe(emailUser.id);
    vi.doUnmock("@/lib/local/identity");
  });
});

describe("hosted fail-closed: nothing reaches the server's own GitHub credential", () => {
  const NOT_CONNECTED = /GitHub is not connected yet/;

  it("the gh runner, status checks and the profile checker never spawn a process", async () => {
    const { defaultGhRunner } = await import("@/lib/github/exec");
    await expect(defaultGhRunner(["api", "user"])).rejects.toThrow(NOT_CONNECTED);
    const { currentGhStatus, checkProfile } = await import("@/lib/local/identity");
    await expect(currentGhStatus(true)).rejects.toThrow(NOT_CONNECTED);
    await db().user.create({ data: { githubId: 1n, login: "server-owner" } });
    expect(await checkProfile()).toEqual({ kind: "hosted" }); // no gh call, and the server owner's login is not shown
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.execFile).not.toHaveBeenCalled();
  });

  it("ports, the profile runner and fetch, discovery, the local actor and the updater all refuse with the typed error", async () => {
    await db().user.create({ data: { githubId: 1n, login: "server-owner" } });
    const { GithubNotConnectedError } = await import("@/lib/github/hosted");
    const { ghPort, portForDiscovery, portForSync, portForWrite } = await import("@/lib/github/factory");
    expect(() => ghPort(db())).toThrow(GithubNotConnectedError);
    await expect(portForDiscovery(db(), { id: "1", login: "x" })).rejects.toThrow(NOT_CONNECTED);
    await expect(portForWrite(db(), { id: "1", login: "x" }, { isDemo: false })).rejects.toThrow(NOT_CONNECTED);
    const ws = await db().workspace.create({ data: { name: "W" } });
    const owner = await db().githubOwner.create({ data: { githubId: 5n, login: "o" } });
    const repo = await db().repository.create({ data: { workspaceId: ws.id, githubId: 9n, ownerId: owner.id, name: "r", fullName: "o/r", htmlUrl: "https://github.com/o/r", visibility: "PRIVATE", defaultBranch: "main" } });
    await expect(portForSync(db(), repo.id)).rejects.toThrow(NOT_CONNECTED);
    const { profileFetch, profileRunner } = await import("@/lib/local/profile-runner");
    await expect(profileFetch(db())("https://api.github.com/user")).rejects.toThrow(NOT_CONNECTED);
    await expect(profileRunner(db())(["api", "user"])).rejects.toThrow(NOT_CONNECTED);
    const { localActor } = await import("@/lib/local/runtime");
    expect(await localActor()).toBeNull();
    const { assertActiveAccount, credentialHelper } = await import("@/lib/local/upstream-updater-job");
    await expect(assertActiveAccount(db(), "github.com")).rejects.toThrow(NOT_CONNECTED);
    expect(() => credentialHelper()).toThrow(NOT_CONNECTED);
    const { startGhLoginAction } = await import("@/app/sign-in/actions");
    expect(await startGhLoginAction()).toEqual({ ok: false, error: expect.stringMatching(NOT_CONNECTED) });
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.execFile).not.toHaveBeenCalled();
  });

  it("a substituted gh runner (as tests and tools can install) is not reached either", async () => {
    const gh = await import("@/lib/github/gh");
    const calls = vi.fn(async () => ({ stdout: "{}", stderr: "", code: 0 }));
    gh.setGhRunner?.(calls);
    try {
      await db().user.create({ data: { githubId: 1n, login: "server-owner" } });
      const { profileRunner } = await import("@/lib/local/profile-runner");
      await expect(profileRunner(db())(["api", "user"])).rejects.toThrow(NOT_CONNECTED);
      expect(calls).not.toHaveBeenCalled();
    } finally {
      gh.setGhRunner?.(gh.defaultGhRunner);
    }
  });

  it("git pushes and fetches (which use gh's credential helper) are refused before git starts", async () => {
    const { createGitWriter } = await import("@/lib/local/git-write");
    const root = os.tmpdir();
    const w = createGitWriter({ root, pushRefs: ["refs/heads/mergeport/x"] });
    await expect(w.run(root, ["fetch", "origin"])).rejects.toThrow(NOT_CONNECTED);
    await expect(w.run(root, ["push", "origin", "refs/heads/a:refs/heads/mergeport/x"])).rejects.toThrow(NOT_CONNECTED);
    expect(spies.execFile).not.toHaveBeenCalled();
  });

  it("an action that hits it answers with the message, not 'something went wrong'", async () => {
    const { run } = await import("@/lib/action-result");
    const { GithubNotConnectedError } = await import("@/lib/github/hosted");
    const r = await run(async () => {
      throw new GithubNotConnectedError();
    });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(NOT_CONNECTED) });
  });
});

describe("the scheduler on a hosted deployment", () => {
  async function seedRepo() {
    const ws = await db().workspace.create({ data: { name: "Tenant" } });
    const owner = await db().githubOwner.create({ data: { githubId: 5n, login: "o" } });
    const repo = await db().repository.create({ data: { workspaceId: ws.id, githubId: 9n, ownerId: owner.id, name: "r", fullName: "o/r", htmlUrl: "https://github.com/o/r", visibility: "PRIVATE", defaultBranch: "main" } });
    return { ws, repo };
  }

  it("GitHub-bound jobs finish as no-ops (DONE, not failed or retried) and touch neither gh nor the budget", async () => {
    const { ws, repo } = await seedRepo();
    const { enqueue, runOne } = await import("@/lib/jobs");
    const { handlers } = await import("@/lib/local/handlers");
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: repo.id }, workspaceId: ws.id });
    await enqueue(db(), { type: "sync.item", payload: { repositoryId: repo.id, number: 1 }, workspaceId: ws.id });
    await enqueue(db(), { type: "upstream.update", payload: { mappingId: "m" }, workspaceId: ws.id });
    for (let i = 0; i < 3; i++) expect(await runOne(db(), handlers)).toBe("done");
    expect(await db().job.count({ where: { status: "DONE" } })).toBe(3);
    expect(await db().job.count({ where: { status: { in: ["FAILED", "QUEUED"] } } })).toBe(0);
    expect(await db().rateLimitState.count({ where: { key: "source" } })).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it("reconcile.all queues nothing (it would only queue GitHub sync), while the same job queues work in the local app", async () => {
    const { repo } = await seedRepo();
    const { runOne, enqueue } = await import("@/lib/jobs");
    const { handlers } = await import("@/lib/local/handlers");
    await enqueue(db(), { type: "reconcile.all", payload: {}, workspaceId: null });
    expect(await runOne(db(), handlers)).toBe("done");
    expect(await db().job.count({ where: { type: "sync.repository" } })).toBe(0);
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    await enqueue(db(), { type: "reconcile.all", payload: {}, workspaceId: null, dedupeKey: "again" });
    expect(await runOne(db(), handlers)).toBe("done");
    expect(await db().job.count({ where: { type: "sync.repository", dedupeKey: `sync:${repo.id}` } })).toBe(1); // control: the skip above was the hosted rule
  });

  it("the coordination lane does no GitHub work and never starts gh", async () => {
    const { coordinate } = await import("@/lib/local/scheduler");
    expect(await coordinate(Date.now())).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(await db().job.count({ where: { type: { in: ["digest.daily", "ai.autopilot"] } } })).toBe(2); // the local-only recurring jobs are still scheduled
    expect(await db().job.count({ where: { type: "reconcile.all" } })).toBe(0);
  });
});

describe("serverActions.allowedOrigins", () => {
  const configFor = async (url: string) => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", url);
    vi.resetModules();
    return (await import("../next.config")).default.experimental as { serverActions?: { allowedOrigins?: string[] } };
  };

  it("names the public host (with its port) in hosted mode and nothing in the local app", async () => {
    expect((await configFor("https://app.example.com")).serverActions?.allowedOrigins).toEqual(["app.example.com"]);
    expect((await configFor("https://app.example.com:8443/some/path")).serverActions?.allowedOrigins).toEqual(["app.example.com:8443"]);
    expect((await configFor("")).serverActions).toBeUndefined();
    expect((await configFor("not a url")).serverActions).toBeUndefined();
  });
});
