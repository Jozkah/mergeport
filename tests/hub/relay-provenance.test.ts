import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { webhookLimits } from "../../hub/src/webhook-routes";
import { deliver, ghRepo, signInAs, startTestHub, type TestHub } from "./harness";

const SECRET = "h".repeat(24) + "0123456789abcdef";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let hub: TestHub;
let olive: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  hub = await startTestHub();
  olive = await signInAs(hub, 1n, "olive");
  expect((await hub.api(olive)("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(204);
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await hub.close();
});

async function join(id: bigint, login: string, role: "MEMBER" | "ADMIN"): Promise<string> {
  hub.github.addUser({ id, login });
  expect((await hub.api(olive)("POST", "/admin/invites", { githubLogin: login, role })).status).toBe(201);
  return signInAs(hub, id, login);
}

/** Opens a socket that watches `repos` and waits until the hub has applied the watch. */
async function watcher(token: string, repos: string[]): Promise<any[]> {
  const ws = new WebSocket(hub.url.replace(/^http/, "ws") + "/ws", ["mergeport.v1", "bearer." + token]);
  sockets.push(ws);
  const msgs: any[] = [];
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
  while (!msgs.some((m) => m.t === "hello")) await sleep(5);
  ws.send(JSON.stringify({ t: "watch", repos }));
  ws.send(JSON.stringify({ t: "ping" }));
  while (!msgs.some((m) => m.t === "pong")) await sleep(5);
  return msgs;
}

const share = (token: string, repoId: number, entityId = `repo-${repoId}`, baseVersion = 0) =>
  hub.api(token)("POST", "/spaces/common/ops", { ops: [{ opId: `op-${entityId}-${baseVersion}-${Math.random().toString(36).slice(2)}`, type: "repo", entityId, kind: "UPSERT", baseVersion, data: { githubId: String(repoId) } }] });

const gh = (msgs: any[]) => msgs.filter((m) => m.t === "gh");

describe("relay provenance", () => {
  it("a MEMBER who forges a repo entity receives no private payload", async () => {
    const mallory = await join(5n, "mallory", "MEMBER");
    expect((await share(mallory, 123)).status).toBe(200);
    const msgs = await watcher(mallory, ["123"]);
    const r = await deliver(hub, SECRET, "issues", { action: "opened", repository: ghRepo(123, "victim", true, 999) });
    expect(r.body).toEqual({ ok: true, notified: 0 });
    await sleep(50);
    expect(gh(msgs)).toEqual([]);
  });

  it("a share by the repository's GitHub owner id still relays", async () => {
    const dana = await join(7n, "dana", "MEMBER");
    const bob = await join(2n, "bob", "MEMBER");
    expect((await share(dana, 321)).status).toBe(200);
    const msgs = await watcher(bob, ["321"]);
    const r = await deliver(hub, SECRET, "issues", { action: "opened", repository: ghRepo(321, "dana", true, 7) });
    expect(r.body).toEqual({ ok: true, notified: 1 });
    await sleep(50);
    expect(gh(msgs)).toHaveLength(1);
  });

  it("a share by an ADMIN still relays and stops relaying after that admin is demoted", async () => {
    const adam = await join(3n, "adam", "ADMIN");
    const bob = await join(2n, "bob", "MEMBER");
    expect((await share(adam, 77)).status).toBe(200);
    const msgs = await watcher(bob, ["77"]);
    const body = { action: "opened", repository: ghRepo(77, "elsewhere", true, 999) };
    expect((await deliver(hub, SECRET, "issues", body)).body).toEqual({ ok: true, notified: 1 });
    // A later write by a MEMBER does not erase the admin's provenance.
    expect((await share(bob, 77, "repo-77", 1)).status).toBe(200);
    expect((await deliver(hub, SECRET, "issues", body)).body).toEqual({ ok: true, notified: 1 });
    expect((await hub.api(olive)("PATCH", "/admin/members/3", { role: "MEMBER" })).status).toBe(200);
    expect((await deliver(hub, SECRET, "issues", body)).body).toEqual({ ok: true, notified: 0 });
    await sleep(50);
    expect(gh(msgs)).toHaveLength(2);
  });

  it("a share by an ADMIN stops relaying after that admin is removed", async () => {
    const adam = await join(3n, "adam", "ADMIN");
    const bob = await join(2n, "bob", "MEMBER");
    expect((await share(adam, 78)).status).toBe(200);
    await watcher(bob, ["78"]);
    const body = { action: "opened", repository: ghRepo(78, "elsewhere", true) };
    expect((await deliver(hub, SECRET, "issues", body)).body).toEqual({ ok: true, notified: 1 });
    expect((await hub.api(olive)("DELETE", "/admin/members/3")).status).toBeLessThan(300);
    expect((await deliver(hub, SECRET, "issues", body)).body).toEqual({ ok: true, notified: 0 });
  });

  it("public repositories relay as before", async () => {
    const bob = await join(2n, "bob", "MEMBER");
    const msgs = await watcher(bob, ["500"]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(500, "anyone") })).body).toEqual({ ok: true, notified: 1 });
    await sleep(50);
    expect(gh(msgs)).toHaveLength(1);
  });
});

describe("op validation", () => {
  it("ops with an entityId or type outside the allowed charset are refused with 400 and nothing is stored", async () => {
    const api = hub.api(olive);
    const op = (type: string, entityId: string) => ({ opId: "x1", type, entityId, kind: "UPSERT", baseVersion: 0, data: {} });
    for (const bad of [op("card", "a/b"), op("card", "a b"), op("card", "../x"), op("card", "é"), op("card", "x".repeat(129)), op("Card!", "ok"), op("t".repeat(64), "ok")]) {
      const r = await api("POST", "/spaces/common/ops", { ops: [bad] });
      expect(r.status).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM entity").get()).toEqual({ n: 0 });
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM entity_event").get()).toEqual({ n: 0 });
    // Ids the client builds still pass.
    for (const id of ["repo-123", "card-clx0abc123def", "3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", "a_b"]) {
      expect((await api("POST", "/spaces/common/ops", { ops: [{ ...op("card", id), opId: `o-${id}` }] })).status).toBe(200);
    }
  });
});

describe("webhook body deadline", () => {
  it("a stalled unsigned body releases its in-flight slot at the deadline and a valid signed delivery then succeeds", async () => {
    const saved = { ...webhookLimits };
    webhookLimits.bodyDeadlineMs = 300;
    webhookLimits.maxInflight = 1;
    try {
      const req = http.request(hub.url + "/webhooks/github", { method: "POST", headers: { "x-github-event": "push", "content-type": "application/json", "content-length": "1000" } });
      const answered = new Promise<number>((resolve) => {
        req.on("response", (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on("error", () => resolve(0));
      });
      req.flushHeaders();
      req.write("{");
      await sleep(100);
      // Slot held by the stalled body.
      expect((await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }))).status).toBe(503);
      expect([0, 408]).toContain(await answered);
      expect((await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }))).status).toBe(200);
      req.destroy();
    } finally {
      Object.assign(webhookLimits, saved);
    }
  });

  it("one address cannot take every in-flight slot", async () => {
    const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
    const stalled: http.ClientRequest[] = [];
    for (let i = 0; i < webhookLimits.maxPerIp; i++) {
      const req = http.request(hub.url + "/webhooks/github", { method: "POST", agent, headers: { "x-github-event": "push", "content-type": "application/json", "content-length": "1000", "x-forwarded-for": "198.51.100.7" } });
      req.on("error", () => undefined);
      req.flushHeaders();
      req.write("{");
      stalled.push(req);
    }
    await sleep(200);
    const same = await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }), { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(same.status).toBe(503);
    const other = await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }), { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(other.status).toBe(200);
    for (const r of stalled) r.destroy();
    agent.destroy();
  });
});
