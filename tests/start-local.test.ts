import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReason, buildWithRetry, onChildExit, RESTART_EXIT_CODE, writeStamp } from "@/lib/local/launcher";
import { LAUNCH_TOKEN_TTL_MS, launchTokenUsable } from "@/lib/local/launch-token";

const roots: string[] = [];
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mp-launcher-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".next"));
  fs.mkdirSync(path.join(root, "prisma"));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), "model A {}");
  return root;
}
const built = (root: string) => fs.writeFileSync(path.join(root, ".next", "BUILD_ID"), "x");
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

describe("build stamp", () => {
  it("builds when there is no build", () => {
    expect(buildReason(repo(), { gitHead: () => "aaa" })).toBe("no build yet");
  });

  it("rebuilds when HEAD changed and not when it is unchanged", () => {
    const root = repo();
    built(root);
    writeStamp(root, { gitHead: () => "aaa" });
    expect(buildReason(root, { gitHead: () => "aaa" })).toBeNull();
    expect(buildReason(root, { gitHead: () => "bbb" })).toMatch(/changed/);
  });

  it("rebuilds when the lockfile or schema changed under the same HEAD", () => {
    const root = repo();
    built(root);
    writeStamp(root, { gitHead: () => "aaa" });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), "model B {}");
    expect(buildReason(root, { gitHead: () => "aaa" })).toMatch(/changed/);
  });

  it("rebuilds an unstamped build (made before the launcher stamped)", () => {
    const root = repo();
    built(root);
    expect(buildReason(root, { gitHead: () => "aaa" })).toMatch(/changed/);
  });

  it("without git, compares source mtimes with BUILD_ID", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, "src"));
    const f = path.join(root, "src", "a.ts");
    fs.writeFileSync(f, "");
    const old = new Date(Date.now() - 60_000);
    for (const p of [f, path.join(root, "src"), path.join(root, "package-lock.json"), path.join(root, "prisma", "schema.prisma")]) fs.utimesSync(p, old, old);
    built(root);
    expect(buildReason(root, { gitHead: () => null })).toBeNull();
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(f, later, later);
    expect(buildReason(root, { gitHead: () => null })).toMatch(/newer/);
  });
});

describe("buildWithRetry", () => {
  it("retries once a first build that stopped with exit 1 after producing BUILD_ID", async () => {
    const root = repo();
    const run = vi.fn().mockImplementationOnce(async () => (built(root), { code: 1, output: "notice" })).mockResolvedValueOnce({ code: 0, output: "" });
    expect(await buildWithRetry(root, run)).toEqual({ ok: true, attempts: 2, code: 0 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries when the output shows the route table", async () => {
    const run = vi.fn().mockResolvedValueOnce({ code: 1, output: "Route (app)  Size" }).mockResolvedValueOnce({ code: 0, output: "" });
    expect((await buildWithRetry(repo(), run)).ok).toBe(true);
  });

  it("retries a build that stopped on the notice before doing any work", async () => {
    const run = vi.fn().mockResolvedValueOnce({ code: 1, output: "This command stopped. Retry the same command to continue." }).mockResolvedValueOnce({ code: 0, output: "" });
    expect((await buildWithRetry(repo(), run)).attempts).toBe(2);
  });

  it("does not retry a real failure, and gives up after the second attempt", async () => {
    const fail = vi.fn().mockResolvedValue({ code: 1, output: "Type error" });
    expect(await buildWithRetry(repo(), fail)).toEqual({ ok: false, attempts: 1, code: 1 });
    const root = repo();
    built(root);
    const twice = vi.fn().mockResolvedValue({ code: 1, output: "" });
    expect(await buildWithRetry(root, twice)).toEqual({ ok: false, attempts: 2, code: 1 });
  });
});

describe("onChildExit", () => {
  it(`exit ${RESTART_EXIT_CODE} relaunches and opens the new link in the browser (also under --no-open)`, async () => {
    const openInBrowser = vi.fn();
    const exit = vi.fn();
    await onChildExit(75, { relaunch: async () => "http://127.0.0.1:3120/api/local/launch?token=new", openInBrowser, exit });
    expect(openInBrowser).toHaveBeenCalledWith("http://127.0.0.1:3120/api/local/launch?token=new");
    expect(exit).not.toHaveBeenCalled();
  });

  it("any other exit ends the launcher with that code", async () => {
    const exit = vi.fn();
    const relaunch = vi.fn();
    await onChildExit(3, { relaunch, openInBrowser: vi.fn(), exit });
    expect(exit).toHaveBeenCalledWith(3);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("a failed relaunch exits 1", async () => {
    const exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await onChildExit(75, { relaunch: async () => Promise.reject(new Error("db locked")), openInBrowser: vi.fn(), exit });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("launch token", () => {
  const base = { given: "tok", expected: "tok", used: false, issuedAt: 1_000_000 };
  it("works before its TTL and is refused after it", () => {
    expect(launchTokenUsable({ ...base, now: base.issuedAt + LAUNCH_TOKEN_TTL_MS })).toBe(true);
    expect(launchTokenUsable({ ...base, now: base.issuedAt + LAUNCH_TOKEN_TTL_MS + 1 })).toBe(false);
    expect(LAUNCH_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });
  it("is single-use and must match", () => {
    expect(launchTokenUsable({ ...base, used: true, now: base.issuedAt })).toBe(false);
    expect(launchTokenUsable({ ...base, given: "nope", now: base.issuedAt })).toBe(false);
    expect(launchTokenUsable({ ...base, expected: undefined, now: base.issuedAt })).toBe(false);
  });
});

describe("GET /api/local/launch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("@/lib/local/session-routes");
    vi.unstubAllEnvs();
    const g = globalThis as { __mpLaunchUsed?: boolean; __mpLaunchIssuedAt?: number };
    delete g.__mpLaunchUsed;
    delete g.__mpLaunchIssuedAt;
  });
  async function load(issuedAt: number) {
    vi.stubEnv("MERGEPORT_LAUNCH_TOKEN", "tok");
    vi.doMock("@/lib/local/session-routes", () => ({ startLocalSession: async () => ({ ok: true }) }));
    (globalThis as { __mpLaunchIssuedAt?: number }).__mpLaunchIssuedAt = issuedAt;
    return (await import("@/app/api/local/launch/route")).GET;
  }
  const req = () => new Request("http://127.0.0.1:3120/api/local/launch?token=tok", { headers: { host: "127.0.0.1:3120" } });

  it("signs in once within the TTL, then refuses", async () => {
    const GET = await load(Date.now());
    expect((await GET(req())).status).toBeGreaterThanOrEqual(300);
    const again = await GET(req());
    expect(again.status).toBe(403);
    expect(await again.text()).toMatch(/Launch link expired/);
  });

  it("refuses an unused link after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000_000_000);
    const GET = await load(5_000_000_000 - LAUNCH_TOKEN_TTL_MS - 1);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/Launch link expired/);
  });
});
