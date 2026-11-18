import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signInAs, startTestHub, type TestHub } from "./harness";

let hub: TestHub;
let clock = Date.parse("2026-11-01T00:00:00Z");
beforeEach(async () => {
  clock = Date.parse("2026-11-01T00:00:00Z");
  hub = await startTestHub({ now: () => clock });
});
afterEach(async () => {
  await hub.close();
});

async function team() {
  const olive = await signInAs(hub, 1n, "olive");
  const inv = async (id: bigint, login: string, role: string) => {
    hub.github.addUser({ id, login });
    expect((await hub.api(olive)("POST", "/admin/invites", { githubLogin: login, role })).status).toBe(201);
    return signInAs(hub, id, login);
  };
  return { olive, adam: await inv(2n, "adam", "ADMIN"), mia: await inv(3n, "mia", "MEMBER"), rae: await inv(4n, "rae", "READER") };
}

describe("pending invites", () => {
  it("an admin lists pending invites and cancels one; a cancelled invite does not admit the invited person", async () => {
    const t = await team();
    hub.github.addUser({ id: 10n, login: "newbie" });
    hub.github.addUser({ id: 11n, login: "typo" });
    const created = (await hub.api(t.adam)("POST", "/admin/invites", { githubLogin: "newbie", role: "MEMBER" })).body.invite;
    await hub.api(t.adam)("POST", "/admin/invites", { githubLogin: "typo", role: "READER" });

    const list = await hub.api(t.adam)("GET", "/admin/invites");
    expect(list.status).toBe(200);
    expect(list.body.invites).toHaveLength(2);
    const row = list.body.invites.find((i: { login: string }) => i.login === "newbie");
    expect(row).toEqual({ id: created.id, login: "newbie", githubId: "10", role: "MEMBER", invitedBy: "adam", createdAt: created.createdAt, expiresAt: created.expiresAt });
    expect(JSON.stringify(list.body)).not.toMatch(/token|secret/i);

    expect((await hub.api(t.adam)("DELETE", `/admin/invites/${created.id}`)).status).toBe(204);
    expect((await hub.api(t.adam)("DELETE", `/admin/invites/${created.id}`)).status).toBe(404);
    expect((await hub.api(t.adam)("GET", "/admin/invites")).body.invites.map((i: { login: string }) => i.login)).toEqual(["typo"]);

    // the cancelled person cannot sign in; the other invite still admits
    const s = (await hub.api()("POST", "/auth/device/start")).body as { deviceCode: string; userCode: string; pollSecret: string };
    hub.github.authorize(s.userCode, 10n);
    const poll = await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: s.pollSecret });
    expect(poll.status).not.toBe(200);
    expect(hub.db.prepare("SELECT 1 FROM member WHERE github_id = 10").get()).toBeUndefined();
    await expect(signInAs(hub, 11n, "typo")).resolves.toBeTruthy();
  });

  it("an admin cannot cancel an admin-role invite; the owner can", async () => {
    const t = await team();
    hub.github.addUser({ id: 10n, login: "newadmin" });
    const id = (await hub.api(t.olive)("POST", "/admin/invites", { githubLogin: "newadmin", role: "ADMIN" })).body.invite.id as string;
    expect((await hub.api(t.adam)("DELETE", `/admin/invites/${id}`)).status).toBe(403);
    expect((await hub.api(t.olive)("DELETE", `/admin/invites/${id}`)).status).toBe(204);
  });

  it("a member or reader gets 403 on both routes", async () => {
    const t = await team();
    hub.github.addUser({ id: 10n, login: "newbie" });
    const id = (await hub.api(t.olive)("POST", "/admin/invites", { githubLogin: "newbie", role: "MEMBER" })).body.invite.id as string;
    for (const who of [t.mia, t.rae]) {
      expect((await hub.api(who)("GET", "/admin/invites")).status).toBe(403);
      expect((await hub.api(who)("DELETE", `/admin/invites/${id}`)).status).toBe(403);
    }
    expect((await hub.api()("GET", "/admin/invites")).status).toBe(401);
    expect((await hub.api(t.olive)("GET", "/admin/invites")).body.invites).toHaveLength(1);
  });

  it("an inviter demoted during the GitHub lookup cannot create the invite", async () => {
    const t = await team();
    hub.github.addUser({ id: 10n, login: "newbie" });
    let release!: () => void;
    hub.github.lookupGate = new Promise<void>((r) => (release = r));
    const pending = hub.api(t.adam)("POST", "/admin/invites", { githubLogin: "newbie", role: "MEMBER" });
    await new Promise((r) => setTimeout(r, 150)); // the hub is now waiting on the lookup
    expect((await hub.api(t.olive)("PATCH", "/admin/members/2", { role: "READER" })).status).toBe(200);
    release();
    expect((await pending).status).toBe(403);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM invite WHERE github_login = 'newbie'").get()).toEqual({ n: 0 });
  });

  it("expired invites are not listed", async () => {
    const t = await team();
    hub.github.addUser({ id: 10n, login: "newbie" });
    await hub.api(t.olive)("POST", "/admin/invites", { githubLogin: "newbie", role: "MEMBER" });
    expect((await hub.api(t.olive)("GET", "/admin/invites")).body.invites).toHaveLength(1);
    const id = (hub.db.prepare("SELECT id FROM invite WHERE github_login = 'newbie'").get() as { id: string }).id;
    clock += 8 * 24 * 60 * 60 * 1000;
    expect((await hub.api(t.olive)("GET", "/admin/invites")).body.invites).toEqual([]);
    expect((await hub.api(t.olive)("DELETE", `/admin/invites/${id}`)).status).toBe(404);
  });
});
