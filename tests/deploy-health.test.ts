import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { resolveBind } from "@/lib/bind-address";
import { HEARTBEAT_KEY, HEARTBEAT_STALE_MS, beat, workerStatus } from "@/lib/worker-heartbeat";
import { pruneGithubAppData } from "@/lib/github/webhook-maintenance";
import { proxy } from "@/proxy";

/** Deployment packaging: bind address, the health endpoint, and the worker heartbeat behind it. */
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
beforeEach(() => {
  state.db = createTestPrisma(`deploy-health-${n++}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("bind address", () => {
  it("defaults to loopback 3000, so local behaviour is unchanged", () => {
    expect(resolveBind({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("reads HOST and MERGEPORT_PORT before PORT", () => {
    const hosted = { MERGEPORT_PUBLIC_URL: ORIGIN };
    expect(resolveBind({ ...hosted, HOST: "0.0.0.0", PORT: "8080" })).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(resolveBind({ ...hosted, HOST: "0.0.0.0", PORT: "8080", MERGEPORT_PORT: "4000" }).port).toBe(4000);
    expect(resolveBind({ MERGEPORT_PORT: "3100", HOST: "localhost" })).toEqual({ host: "localhost", port: 3100 });
  });

  it("refuses a network-reachable bind unless hosted mode is configured (loopback Host exemptions must never face the network)", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "myserver"]) expect(() => resolveBind({ HOST: host }), host).toThrow(/MERGEPORT_PUBLIC_URL/);
    expect(() => resolveBind({ HOST: "0.0.0.0", MERGEPORT_PUBLIC_URL: "not a url" })).toThrow(/MERGEPORT_PUBLIC_URL/);
    expect(() => resolveBind({ HOST: "0.0.0.0", MERGEPORT_PUBLIC_URL: "ftp://x.test" })).toThrow(/MERGEPORT_PUBLIC_URL/);
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(() => resolveBind({ HOST: host }), host).not.toThrow();
    expect(resolveBind({ HOST: "0.0.0.0", MERGEPORT_PUBLIC_URL: ORIGIN }).host).toBe("0.0.0.0");
  });

  it("rejects a bad port or host", () => {
    for (const p of ["0", "65536", "abc", "30 00", "-1", "3000.5"]) expect(() => resolveBind({ PORT: p }), p).toThrow(/port/);
    expect(() => resolveBind({ HOST: "bad host;rm" })).toThrow(/not a valid/);
  });
});

const at = (host: string, path: string, method = "GET", headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`http://${host}${path}`, { method, headers: { host, ...headers } }));
const passes = (r: Response) => Boolean(r.headers.get("x-middleware-next"));

describe("the proxy with the server bound to 0.0.0.0 (hosted)", () => {
  beforeEach(() => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  });

  it("serves /api/health to a platform probe under any Host, GET and HEAD only", () => {
    for (const h of ["127.0.0.1:3000", "10.0.0.7:3000", "0.0.0.0:3000", HOST]) {
      expect(passes(at(h, "/api/health")), h).toBe(true);
      expect(passes(at(h, "/api/health", "HEAD")), h).toBe(true);
    }
    expect(at("10.0.0.7:3000", "/api/health", "POST", { origin: "http://10.0.0.7:3000" }).status).toBe(403);
    expect(at("10.0.0.7:3000", "/api/health/", "GET").status).toBe(403);
    expect(at("10.0.0.7:3000", "/api/health/x", "GET").status).toBe(403);
  });

  it("opens no loopback or demo exemption: every other path still needs the public Host", () => {
    for (const h of ["127.0.0.1:3000", "localhost:3000", "0.0.0.0:3000", "10.0.0.7:3000"]) {
      for (const p of ["/", "/sign-in", "/api/local/demo", "/api/local/signout", "/api/mcp", "/api/backup/export"]) expect(at(h, p).status, `${h} ${p}`).toBe(403);
    }
    expect(passes(at(HOST, "/sign-in"))).toBe(true);
    expect(at(HOST, "/api/local/demo").status).toBe(404);
  });

  it("answers health with no-store", () => {
    expect(at(HOST, "/api/health").headers.get("cache-control")).toBe("no-store");
  });
});

describe("the proxy in the local app", () => {
  it("still refuses a non-loopback Host everywhere but the health probe", () => {
    expect(at("0.0.0.0:3000", "/sign-in").status).toBe(403);
    expect(at("10.0.0.7:3000", "/").status).toBe(403);
    expect(passes(at("10.0.0.7:3000", "/api/health"))).toBe(true);
    expect(passes(at("127.0.0.1:3000", "/sign-in"))).toBe(true);
  });
});

describe("worker heartbeat", () => {
  it("is unknown without a beat, fresh after one, stale after four missed", async () => {
    const db = state.db!;
    const t0 = new Date("2026-12-01T10:00:00Z");
    expect(await workerStatus(db, t0)).toBe("unknown");
    await beat(db, t0);
    expect(await workerStatus(db, new Date(t0.getTime() + 5_000))).toBe("fresh");
    expect(await workerStatus(db, new Date(t0.getTime() + HEARTBEAT_STALE_MS))).toBe("fresh");
    expect(await workerStatus(db, new Date(t0.getTime() + HEARTBEAT_STALE_MS + 1))).toBe("stale");
  });

  it("keeps the newest beat when workers race, and one row only", async () => {
    const db = state.db!;
    const t0 = new Date("2026-12-01T10:00:00Z");
    await beat(db, new Date(t0.getTime() + 10_000));
    await beat(db, t0); // a slower worker's older stamp must not move it back
    const rows = await db.rateLimitState.findMany({ where: { key: HEARTBEAT_KEY } });
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt.getTime()).toBe(t0.getTime() + 10_000);
  });

  it("survives the daily counter prune while a worker is alive", async () => {
    const db = state.db!;
    await beat(db, new Date());
    await pruneGithubAppData(db, new Date(Date.now() + 24 * 3_600_000));
    expect(await db.rateLimitState.count({ where: { key: HEARTBEAT_KEY } })).toBe(1);
  });
});

let clock = Date.now();
describe("GET /api/health", () => {
  const call = async (method: "GET" | "HEAD" = "GET") => {
    const mod = await import("@/app/api/health/route");
    return mod[method]();
  };
  // The route keeps one shared result per module for 2 s. A clock that only moves forward (10 minutes per test) keeps tests from reading each other's.
  const tick = (ms = 600_000) => vi.setSystemTime((clock += ms));
  const start = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    tick();
  };

  it("answers 200 {ok, worker} and nothing else, with the worker state from the heartbeat", async () => {
    start();
    let r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, worker: "unknown" });

    await beat(state.db!);
    tick(10_000);
    r = await call();
    expect(await r.json()).toEqual({ ok: true, worker: "fresh" });

    tick(HEARTBEAT_STALE_MS + 10_000);
    r = await call();
    expect(await r.json()).toEqual({ ok: true, worker: "stale" });
  });

  it("answers HEAD too, and shares one probe between rapid calls", async () => {
    start();
    const spy = vi.spyOn(state.db!, "$queryRaw");
    await Promise.all([call(), call("HEAD"), call()]);
    expect(spy).toHaveBeenCalledTimes(1);
    const r = await call("HEAD");
    expect(r.status).toBe(200);
  });

  it("answers 503 {ok:false} with no detail when the database does not answer", async () => {
    start();
    state.db = { $queryRaw: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2"); } } as never;
    const r = await call();
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
  });

  it("reports worker unknown, still 200, when only the heartbeat read fails", async () => {
    start();
    const real = state.db!;
    state.db = { $queryRaw: real.$queryRaw.bind(real), rateLimitState: { findUnique: async () => { throw new Error("boom"); } } } as never;
    const r = await call();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, worker: "unknown" });
  });
});
