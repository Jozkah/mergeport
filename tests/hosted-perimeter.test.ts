import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, formPost, state } from "./auth-mocks";

/**
 * A hosted deployment must not expose the demo's sign-in route, must not accept loopback Host names (a proxy can forward a
 * client's own header), and reaches GitHub only through a workspace's own installation.
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
  const LOCAL_ROUTES = ["/api/local/demo"];

  it("answers 404 to every /api/local route on the public host (except sign-out)", async () => {
    for (const p of LOCAL_ROUTES) {
      expect((await proxyAt(HOST, p, { method: "POST", origin: ORIGIN })).status, p).toBe(404);
      expect((await proxyAt(HOST, p)).status, p).toBe(404);
    }
    expect((await proxyAt(HOST, "/api/local/signout", { method: "POST", origin: ORIGIN })).status).toBe(200);
    expect((await proxyAt(HOST, "/sign-in")).status).toBe(200);
  });

  it("refuses a loopback Host (as a proxy might forward from a client) everywhere", async () => {
    for (const p of ["/sign-in", "/", "/api/local/demo", "/auth/magic/request"]) {
      expect((await proxyAt("127.0.0.1:3000", p, { method: p.startsWith("/api") || p.startsWith("/auth") ? "POST" : "GET", origin: "http://127.0.0.1:3000" })).status, p).toBe(403);
    }
    expect((await proxyAt("localhost:3000", "/sign-in")).status).toBe(403);
    expect((await proxyAt("[::1]:3000", "/sign-in")).status).toBe(403);
  });

  it("the local app still accepts loopback only and never the public name", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await proxyAt("127.0.0.1:3000", "/sign-in")).status).toBe(200);
    expect((await proxyAt(HOST, "/sign-in")).status).toBe(403);
    expect((await proxyAt("127.0.0.1:3000", "/api/local/demo", { method: "POST", origin: "http://127.0.0.1:3000" })).status).toBe(200);
  });
});

describe("the local routes themselves refuse a hosted request (the proxy is not the only gate)", () => {
  const post = (path: string, extra: Record<string, string> = {}) => formPost(path, { as: "admin" }, extra);

  it("POST /api/local/demo : 404, no session", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const user = await db().user.create({ data: { githubId: 11n, login: "server-owner" } });
    const routes: [string, string][] = [["demo", "@/app/api/local/demo/route"]];
    for (const [name, mod] of routes) {
      const res = await (await import(/* @vite-ignore */ mod)).POST(post(`/api/local/${name}`));
      expect(res.status, name).toBe(404);
    }
    expect(await db().session.count({ where: { userId: user.id } })).toBe(0);
    expect(state.jar.size).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it("sign-out keeps working", async () => {
    const out = await (await import("@/app/api/local/signout/route")).POST(post("/api/local/signout"));
    expect(out.status).toBe(303);
  });
});

describe("GitHub is reached only through a workspace's installation", () => {
  const NOT_CONNECTED = /GitHub is not connected yet/;

  it("a repository without a connection refuses with the typed error, and writes are off", async () => {
    const { portForSync, portForWrite } = await import("@/lib/github/factory");
    // Behaviour change of the GitHub App phase: hosted workspaces read through their installation, and writes are off for everyone (not "not connected").
    await expect(portForWrite(db(), { id: "1", login: "x" }, { isDemo: false })).rejects.toThrow(/GitHub writes are not enabled yet/);
    const ws = await db().workspace.create({ data: { name: "W" } });
    const owner = await db().githubOwner.create({ data: { githubId: 5n, login: "o" } });
    const repo = await db().repository.create({ data: { workspaceId: ws.id, githubId: 9n, ownerId: owner.id, name: "r", fullName: "o/r", htmlUrl: "https://github.com/o/r", visibility: "PRIVATE", defaultBranch: "main" } });
    await expect(portForSync(db(), repo.id)).rejects.toThrow(NOT_CONNECTED);
    expect(spies.spawn).not.toHaveBeenCalled();
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
    const { handlers } = await import("@/lib/worker/handlers");
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: repo.id }, workspaceId: ws.id });
    await enqueue(db(), { type: "sync.item", payload: { repositoryId: repo.id, number: 1 }, workspaceId: ws.id });
    for (let i = 0; i < 2; i++) expect(await runOne(db(), handlers)).toBe("done");
    expect(await db().job.count({ where: { status: "DONE" } })).toBe(2);
    expect(await db().job.count({ where: { status: { in: ["FAILED", "QUEUED"] } } })).toBe(0);
    expect(await db().rateLimitState.count({ where: { key: "source" } })).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it("reconcile.all queues nothing for a workspace without a connection", async () => {
    await seedRepo();
    const { runOne, enqueue } = await import("@/lib/jobs");
    const { handlers } = await import("@/lib/worker/handlers");
    await enqueue(db(), { type: "reconcile.all", payload: {}, workspaceId: null });
    expect(await runOne(db(), handlers)).toBe("done");
    expect(await db().job.count({ where: { type: "sync.repository" } })).toBe(0);
  });

  it("the coordination lane does no GitHub work and starts no process", async () => {
    const { coordinate } = await import("@/lib/worker/scheduler");
    expect(await coordinate(Date.now())).toBe(0);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(await db().job.count({ where: { type: { in: ["digest.daily", "ai.autopilot"] } } })).toBe(2); // the recurring jobs that need no GitHub are still scheduled
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
