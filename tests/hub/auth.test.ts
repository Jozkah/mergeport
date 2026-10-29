import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestHub, type TestHub } from "./harness";

const DAY = 24 * 60 * 60 * 1000;
let hub: TestHub;
let clock: number;

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 29);
  hub = await startTestHub({ now: () => clock });
});
afterEach(async () => {
  await hub.close();
});

async function start() {
  return (await hub.api()("POST", "/auth/device/start")).body as { deviceCode: string; userCode: string };
}
/** Full sign-in for an already-added fake user; returns the poll result. */
async function signIn(id: bigint) {
  const s = await start();
  hub.github.authorize(s.userCode, id);
  return hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode });
}

describe("device-flow sign-in", () => {
  it("requests exactly the read:user scope", async () => {
    await start();
    const req = hub.github.requests.find((r) => r.path === "/login/device/code")!;
    expect(req.body).toMatchObject({ client_id: "test-client", scope: "read:user" });
  });

  it("start returns the device-flow fields", async () => {
    const r = await hub.api()("POST", "/auth/device/start");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ interval: 5, expiresIn: 900 });
    expect(r.body.deviceCode).toBeTruthy();
    expect(r.body.userCode).toMatch(/-/);
    expect(r.body.verificationUri).toContain("/login/device");
  });

  it("first sign-in bootstraps the owner and names the team", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const start = (await hub.api()("POST", "/auth/device/start")).body;
    expect((await hub.api()("POST", "/auth/device/poll", { deviceCode: start.deviceCode })).status).toBe(202);
    hub.github.authorize(start.userCode, 101n);
    const r = await hub.api()("POST", "/auth/device/poll", { deviceCode: start.deviceCode });
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ githubId: "101", login: "olive", role: "OWNER", status: "ACTIVE" });
    expect(r.body.team.name).toBe("olive's team");
    expect((await hub.api()("GET", "/health")).body.team).toEqual({ name: "olive's team" });
  });

  it("a second person is refused until invited, then admitted with the invite's role", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice", name: "Alice A" });
    expect((await signIn(101n)).status).toBe(200);
    const refused = await signIn(202n);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ reason: "not-invited" });

    // Invite endpoint arrives in Task 3; insert the row it would create.
    hub.db
      .prepare("INSERT INTO invite (id, github_login, role, created_by, created_at, expires_at) VALUES ('i1', 'Alice', 'MEMBER', 101, ?, ?)")
      .run(new Date(clock).toISOString(), new Date(clock + 7 * DAY).toISOString());
    const ok = await signIn(202n);
    expect(ok.status).toBe(200);
    expect(ok.body.member).toMatchObject({ githubId: "202", login: "alice", name: "Alice A", role: "MEMBER", status: "ACTIVE" });
    expect(hub.db.prepare("SELECT used_at FROM invite WHERE id = 'i1'").get()).toEqual({ used_at: new Date(clock).toISOString() });
  });

  it("an expired invite does not admit", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    await signIn(101n);
    hub.db
      .prepare("INSERT INTO invite (id, github_login, role, created_by, created_at, expires_at) VALUES ('old', 'alice', 'MEMBER', 101, ?, ?)")
      .run(new Date(clock - 8 * DAY).toISOString(), new Date(clock - DAY).toISOString());
    expect((await signIn(202n)).body).toEqual({ reason: "not-invited" });
  });

  it("an active member's profile refreshes on sign-in", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    await signIn(101n);
    hub.github.addUser({ id: 101n, login: "olive2", name: "Olive", avatarUrl: "http://a/x.png" });
    const r = await signIn(101n);
    expect(r.body.member).toMatchObject({ login: "olive2", name: "Olive", avatarUrl: "http://a/x.png", role: "OWNER" });
  });

  it("a removed member gets 403 removed on sign-in", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    await signIn(101n);
    hub.db.prepare("INSERT INTO member (github_id, login, role, status) VALUES (202, 'alice', 'MEMBER', 'REMOVED')").run();
    const r = await signIn(202n);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ reason: "removed" });
  });

  it.todo("a removed member's old session dies via DELETE /admin/members/:id (Task 3)");

  it("a session of a removed member gets 403 removed", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    hub.db.prepare("UPDATE member SET status = 'REMOVED' WHERE github_id = 101").run();
    const r = await hub.api(token)("GET", "/me");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "removed" });
  });

  it("denied and expired device codes", async () => {
    const d = await start();
    hub.github.deny(d.userCode);
    const denied = await hub.api()("POST", "/auth/device/poll", { deviceCode: d.deviceCode });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ reason: "denied" });

    const e = await start();
    hub.github.expire(e.userCode);
    const expired = await hub.api()("POST", "/auth/device/poll", { deviceCode: e.deviceCode });
    expect(expired.status).toBe(410);
    expect(expired.body).toEqual({ error: "expired" });
  });

  it.each([9007199254740993n, 9223372036854775807n])("GitHub id %s keeps full precision through sign-in, /me and logout", async (id) => {
    hub.github.addUser({ id, login: "big" });
    const r = await signIn(id);
    expect(r.status).toBe(200);
    expect(r.body.member.githubId).toBe(id.toString());
    const token = r.body.session as string;
    const me = await hub.api(token)("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.member.githubId).toBe(id.toString());
    expect(me.body.members[0].githubId).toBe(id.toString());
    expect((await signIn(id)).body.member.githubId).toBe(id.toString());
    expect((await hub.api(token)("POST", "/auth/logout")).status).toBe(204);
    expect((await hub.api(token)("GET", "/me")).status).toBe(401);
  });

  it("poll rejects a missing deviceCode with 400", async () => {
    expect((await hub.api()("POST", "/auth/device/poll", {})).status).toBe(400);
  });
});

describe("sessions", () => {
  it("stores only the SHA-256 of a 32-byte base64url token", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = hub.db.prepare("SELECT id_hash FROM session").all() as { id_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].id_hash).not.toBe(token);
  });

  it("sessions slide 30 days and expire unused", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    clock += 29 * DAY;
    expect((await hub.api(token)("GET", "/me")).status).toBe(200);
    clock += 29 * DAY; // 58 days since sign-in, 29 since last use: slid
    expect((await hub.api(token)("GET", "/me")).status).toBe(200);
    clock += 31 * DAY;
    expect((await hub.api(token)("GET", "/me")).status).toBe(401);
  });

  it("GET /me returns member, team, members, spaces", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    const r = await hub.api(token)("GET", "/me");
    expect(r.status).toBe(200);
    expect(r.body.member.login).toBe("olive");
    expect(r.body.team.name).toBe("olive's team");
    expect(r.body.members).toHaveLength(1);
    expect(r.body.spaces).toEqual([]);
  });

  it("logout kills only that session", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const a = (await signIn(101n)).body.session as string;
    const b = (await signIn(101n)).body.session as string;
    expect((await hub.api(a)("POST", "/auth/logout")).status).toBe(204);
    expect((await hub.api(a)("GET", "/me")).status).toBe(401);
    expect((await hub.api(b)("GET", "/me")).status).toBe(200);
  });

  it("malformed Authorization is 401, not 500", async () => {
    for (const h of ["Bearer", "Bearer ", "Basic abc", "Token x", "Bearer a b", "Bearer é", "bearer", "Bearer nope"]) {
      const r = await fetch(hub.url + "/me", { headers: { authorization: h } });
      expect(r.status, h).toBe(401);
    }
    expect((await fetch(hub.url + "/me")).status).toBe(401);
  });
});

describe("GitHub token hygiene", () => {
  it("the GitHub access token is never stored or logged", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    expect((await signIn(101n)).status).toBe(200);
    const tokens = [...hub.github.tokens.keys()];
    expect(tokens.length).toBeGreaterThan(0);

    const tables = (hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const dump = JSON.stringify(hub.db.prepare(`SELECT * FROM "${t}"`).all());
      for (const tok of tokens) expect(dump, `table ${t}`).not.toContain(tok);
    }
    expect(hub.logs.length).toBeGreaterThan(0);
    for (const line of hub.logs) for (const tok of tokens) expect(line).not.toContain(tok);
  });
});
