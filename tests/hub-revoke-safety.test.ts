import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadViewer } from "@/lib/authz/viewer";
import { saveUpdateConfig } from "@/lib/services/upstream-update";
import { FakeHub } from "./hub-client/fake-hub";
import { makeHubClient, projectData, type HubTestClient } from "./hub-client/harness";

let hub: FakeHub;
let olive: HubTestClient;
let alice: HubTestClient;
const open: HubTestClient[] = [];

beforeEach(async () => {
  hub = new FakeHub();
  hub.addMember("1", "olive", "OWNER");
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  hub.createSpace("secret", "RESTRICTED", "Secret", ["1"]);
  await hub.listen();
  olive = await makeHubClient(hub, 1n, "olive");
  alice = await makeHubClient(hub, 2n, "alice");
  open.push(olive, alice);
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await hub.close();
});

/** A repository this profile tracks itself (optionally shared into a space). */
async function ownRepo(c: HubTestClient, githubId: bigint, name: string, spaceId: string | null) {
  const owner = await c.db.githubOwner.upsert({ where: { githubId: 900n }, create: { githubId: 900n, login: "acme", type: "ORGANIZATION" }, update: {} });
  return c.db.repository.create({ data: { workspaceId: c.profile.workspace.id, githubId, ownerId: owner.id, name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, spaceId } });
}

describe("hub revocation safety", () => {
  const seed = async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    await alice.sync();
    expect(await alice.db.project.count()).toBe(1);
  };

  it("an HTML 404 from a proxy does not purge the space and surfaces a sync error", async () => {
    await seed();
    hub.failNext(1, "not-found", "<html><body>404 Not Found</body></html>");
    await alice.engine.syncSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.access).toBe("OK");
    expect(sp.lastError).toMatch(/nothing was removed/i);
    expect(await alice.db.project.count()).toBe(1);
    expect(await alice.db.syncEntity.count({ where: { spaceId: sp.id } })).toBe(1);
  });

  it("a 403 JSON error that is not the hub's revocation shape does not purge", async () => {
    await seed();
    hub.failNext(1, "forbidden", JSON.stringify({ error: "blocked by policy" }));
    await alice.engine.syncSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.access).toBe("OK");
    expect(sp.lastError).toBeTruthy();
    expect(await alice.db.project.count()).toBe(1);
  });

  it("a revocation-shaped 404 the hub's member listing contradicts does not purge", async () => {
    await seed();
    hub.failNext(1, "not-found", JSON.stringify({ error: "space not found" }));
    await alice.engine.syncSpace(await alice.space("common"));
    expect((await alice.space("common")).access).toBe("OK");
    expect(await alice.db.project.count()).toBe(1);
  });

  it("a real revocation (the hub removed the member) detaches the profile's own tracked repositories instead of deleting them and keeps ForkMapping and UpstreamUpdateConfig rows", async () => {
    await alice.sync();
    const common = await alice.space("common");
    const fork = await ownRepo(alice, 11n, "fork", common.id);
    const up = await ownRepo(alice, 12n, "upstream", common.id);
    const map = await alice.db.forkMapping.create({ data: { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: "main", upstreamBranch: "main" } });
    await alice.db.upstreamUpdateConfig.create({ data: { mappingId: map.id, enabled: true } });
    await alice.sync(); // shares the repositories and the mapping
    expect(hub.entity("common", "repo", "repo-11")).toBeTruthy();
    expect(hub.entity("common", "forkmap", map.id)).toBeTruthy();
    hub.inject("common", { type: "project", id: "p1", data: projectData("Theirs") });
    await alice.sync();
    expect(await alice.db.project.count()).toBe(1);

    hub.removeMember("2");
    await alice.sync();
    expect((await alice.space("common")).access).toBe("REVOKED");
    const repos = await alice.db.repository.findMany({ orderBy: { githubId: "asc" } });
    expect(repos.map((r) => [r.githubId, r.spaceId])).toEqual([[11n, null], [12n, null]]);
    expect(await alice.db.forkMapping.count()).toBe(1);
    expect(await alice.db.upstreamUpdateConfig.count()).toBe(1);
    expect(await alice.db.project.count()).toBe(0); // delivered only by the space: purged
  });

  it("after a revoked restricted space the hub owner is still ADMIN and can save an update config", async () => {
    await olive.sync();
    const fork = await ownRepo(olive, 21n, "fork", null);
    const up = await ownRepo(olive, 22n, "upstream", null);
    const map = await olive.db.forkMapping.create({ data: { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: "main", upstreamBranch: "main" } });
    hub.deleteSpace("secret");
    await olive.sync();
    expect((await olive.space("secret")).access).toBe("REVOKED");
    expect((await olive.db.member.findFirstOrThrow()).role).toBe("ADMIN");
    const v = (await loadViewer(olive.db, olive.profile.user.id))!;
    await saveUpdateConfig(olive.db, v, map.id, { mode: "merge", enabled: true, verifyCommand: "", promote: "pr" });
    expect(await olive.db.upstreamUpdateConfig.count({ where: { mappingId: map.id, enabled: true } })).toBe(1);
  });

  it("a hub member's local role follows the hub role", async () => {
    await alice.sync();
    expect((await alice.db.member.findFirstOrThrow()).role).toBe("MEMBER");
    hub.setRole("2", "ADMIN");
    await alice.sync();
    expect((await alice.db.member.findFirstOrThrow()).role).toBe("ADMIN");
  });
});
