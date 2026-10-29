import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubBackendId } from "@/lib/local/backends";
import { readActive } from "@/lib/local/registry";
import { resetEnvCache } from "@/lib/env";
import type { GhStatus } from "@/lib/github/gh";
import { startFakeHub } from "./fake-hub";

const m = vi.hoisted(() => ({ gh: null as unknown, requestSwitch: vi.fn() }));
vi.mock("@/lib/local/identity", () => ({ currentGhStatus: async () => m.gh }));
vi.mock("@/lib/local/switch-client", () => ({ requestSwitch: m.requestSwitch }));

import { POST as check } from "@/app/api/local/hub/check/route";
import { POST as start } from "@/app/api/local/hub/start/route";
import { POST as poll } from "@/app/api/local/hub/poll/route";

const ghOk = (id: bigint): GhStatus => ({ state: "ok", identity: { id, login: "octocat", name: null, avatarUrl: null, host: "github.com" } });
const GH_URI = "https://github.com/login/device";
const hubs: { stop(): Promise<void> }[] = [];
let home: string;
const hub = async (o: Parameters<typeof startFakeHub>[0] = {}) => {
  const h = await startFakeHub({ verificationUri: GH_URI, githubId: "42", ...o });
  hubs.push(h);
  return h;
};
const req = (p: string, body: unknown, headers: Record<string, string> = { origin: "http://127.0.0.1:3000" }) =>
  new Request(`http://127.0.0.1:3000/api/local/hub/${p}`, { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-hubroutes-"));
  process.env.MERGEPORT_HOME = home;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  m.gh = ghOk(42n);
  m.requestSwitch.mockReset();
  m.requestSwitch.mockResolvedValue({ launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old" });
});
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  delete process.env.MERGEPORT_HOME;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("hub connect routes", () => {
  it("refuse cross-origin and demo mode", async () => {
    const h = await hub();
    for (const r of [check, start, poll]) expect((await r(req("x", { url: h.origin, deviceCode: "d" }, { origin: "http://evil.example" }))).status).toBe(403);
    process.env.DEMO_MODE = "true";
    resetEnvCache();
    for (const r of [check, start, poll]) expect((await r(req("x", { url: h.origin, deviceCode: "d" }))).status).toBe(403);
    expect(h.requests.length).toBe(0);
  });

  it("check returns team and origin; mismatched publicUrl and bad input give ok:false", async () => {
    const h = await hub();
    expect(await (await check(req("check", { url: h.origin + "/" }))).json()).toEqual({ ok: true, teamName: "Fake Team", origin: h.origin });
    const bad = await hub({ publicUrl: "https://elsewhere.example.com" });
    expect(await (await check(req("check", { url: bad.origin }))).json()).toMatchObject({ ok: false });
    expect(await (await check(req("check", { url: 5 }))).json()).toMatchObject({ ok: false });
    expect(await (await check(req("check", { url: "http://example.com" }))).json()).toMatchObject({ ok: false });
  });

  it("start returns the code and a validated verification uri", async () => {
    const h = await hub();
    expect(await (await start(req("start", { url: h.origin }))).json()).toEqual({ ok: true, userCode: "ABCD-1234", verificationUri: GH_URI, interval: 1, deviceCode: "dev-code-secret" });
  });

  it("start refuses a verification uri on another host", async () => {
    for (const verificationUri of ["https://evil.example/login/device", "http://github.com/login/device", "javascript:alert(1)"]) {
      const h = await hub({ verificationUri });
      const j = await (await start(req("start", { url: h.origin }))).json();
      expect(j.ok).toBe(false);
      expect(JSON.stringify(j)).not.toContain("evil.example");
      expect(JSON.stringify(j)).not.toContain("dev-code-secret");
    }
  });

  it("start then pending then ok writes active.json, switches once, and never leaks the session", async () => {
    const h = await hub({ pollsBeforeOk: 1 });
    const s = await (await start(req("start", { url: h.origin }))).json();
    const p1 = await (await poll(req("poll", { url: h.origin, deviceCode: s.deviceCode }))).json();
    expect(p1).toEqual({ status: "pending" });
    const res = await poll(req("poll", { url: h.origin, deviceCode: s.deviceCode }));
    const text = await res.text();
    const backend = hubBackendId(h.origin);
    expect(JSON.parse(text)).toEqual({ status: "ok", switch: { launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old", expectedBackend: backend } });
    expect(text).not.toContain("session-token-secret");
    expect(readActive(home)).toEqual({ host: "github.com", accountId: "42", backend });
    expect(m.requestSwitch).toHaveBeenCalledTimes(1);
    expect(m.requestSwitch).toHaveBeenCalledWith(backend);
  });

  it("gh as another account gives mismatch and no files", async () => {
    const h = await hub();
    m.gh = ghOk(43n);
    const j = await (await poll(req("poll", { url: h.origin, deviceCode: "d" }))).json();
    expect(j).toEqual({ status: "error", error: "mismatch" });
    expect(fs.readdirSync(home)).toEqual([]);
    expect(m.requestSwitch).not.toHaveBeenCalled();
  });

  it("maps refusals and expiry", async () => {
    const a = await hub({ invited: false });
    expect(await (await poll(req("poll", { url: a.origin, deviceCode: "d" }))).json()).toEqual({ status: "refused", reason: "not-invited" });
    const b = await hub({ removed: true });
    expect(await (await poll(req("poll", { url: b.origin, deviceCode: "d" }))).json()).toEqual({ status: "refused", reason: "removed" });
    const c = await hub({ expired: true });
    expect(await (await poll(req("poll", { url: c.origin, deviceCode: "d" }))).json()).toEqual({ status: "expired" });
  });

  it("reports a failed switch without leaking", async () => {
    const h = await hub();
    m.requestSwitch.mockRejectedValue(new Error("Switching needs the launcher. Start Mergeport with npm run local."));
    const j = await (await poll(req("poll", { url: h.origin, deviceCode: "d" }))).json();
    expect(j).toMatchObject({ status: "error", error: "switch" });
    expect(JSON.stringify(j)).not.toContain("session-token-secret");
  });
});
