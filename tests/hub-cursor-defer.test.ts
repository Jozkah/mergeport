import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityDef } from "@/lib/sync/entities";
import { HUB_DEFER_MAX_ATTEMPTS } from "@/lib/sync/engine";
import { FakeHub } from "./hub-client/fake-hub";
import { cardData, makeHubClient, projectData, type HubTestClient } from "./hub-client/harness";

let hub: FakeHub;
let alice: HubTestClient;

beforeEach(async () => {
  hub = new FakeHub();
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  await hub.listen();
  alice = await makeHubClient(hub, 2n, "alice");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await alice.close();
  await hub.close();
});

const repoData = (githubId: string, name: string) => ({
  githubId, fullName: `acme/${name}`, name, htmlUrl: `https://github.com/acme/${name}`, description: null, visibility: "PRIVATE", isFork: false, parentGithubId: null, parentFullName: null, defaultBranch: "main", archived: false,
  owner: { githubId: "900", login: "acme", type: "ORGANIZATION", avatarUrl: null },
});
const forkmapData = { forkRepoGithubId: "11", upstreamRepoGithubId: "12", forkBranch: "main", upstreamBranch: "main" };

describe("hub cursor and deferred entities", () => {
  it("a forkmap whose upstream is missing does not hold the cursor and does not force a snapshot after a hub restart", async () => {
    hub.epoch = "e1";
    hub.inject("common", { type: "repo", id: "repo-11", data: repoData("11", "fork") });
    hub.inject("common", { type: "forkmap", id: "fm1", data: forkmapData }); // upstream repo 12 is not in this workspace
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    await alice.sync();
    let sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));
    expect(await alice.db.project.count()).toBe(1);
    expect(await alice.db.forkMapping.count()).toBe(0);
    expect(sp.lastError).toMatch(/fm1/);

    hub.epoch = "e2"; // the hub restarted
    const snap = vi.spyOn(alice.client, "snapshot");
    await alice.sync(); // a new process: compared once against a snapshot
    expect(snap).toHaveBeenCalledTimes(1);
    hub.inject("common", { type: "project", id: "p2", data: projectData("Second") });
    await alice.sync();
    expect(snap).toHaveBeenCalledTimes(1); // and not again
    sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));
    expect(await alice.db.project.count()).toBe(2);
  });

  it("a malformed entity (including a throwing apply) is skipped and later valid events still apply", async () => {
    const card = entityDef("card")!;
    const real = card.apply.bind(card);
    vi.spyOn(card, "apply").mockImplementation(async (db, ctx, id, data, version) => {
      if (id === "boom") throw new Error("garbage");
      return real(db, ctx, id, data, version);
    });
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    hub.inject("common", { type: "card", id: "boom", data: cardData("p1", "Throws") });
    hub.inject("common", { type: "repo", id: "repo-x", data: { githubId: "not-a-number" } }); // malformed
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Fine") });
    await alice.sync();
    let sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).not.toBeNull();
    expect(sp.lastError).toMatch(/^Skipped 2 /);

    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Later") });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c2" } })).not.toBeNull();
    sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));

    // Retried a bounded number of times, then given up with a visible note.
    for (let i = 0; i < HUB_DEFER_MAX_ATTEMPTS + 1; i++) await alice.sync();
    const calls = vi.mocked(card.apply).mock.calls.filter((c) => c[2] === "boom").length;
    expect(calls).toBe(HUB_DEFER_MAX_ATTEMPTS);
    expect((await alice.space("common")).lastError).toMatch(/gave up/);
  });

  it("a deferred entity is retried when its dependency arrives", async () => {
    hub.inject("common", { type: "forkmap", id: "fm1", data: forkmapData });
    await alice.sync();
    expect(await alice.db.forkMapping.count()).toBe(0);
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));

    hub.inject("common", { type: "repo", id: "repo-11", data: repoData("11", "fork") });
    hub.inject("common", { type: "repo", id: "repo-12", data: repoData("12", "upstream") });
    await alice.sync();
    expect(await alice.db.forkMapping.findUnique({ where: { id: "fm1" } })).not.toBeNull();
    const sp = await alice.space("common");
    expect(sp.lastError).toBeNull();
    expect(sp.hubCursor).toBe(hub.seq("common"));
  });
});
