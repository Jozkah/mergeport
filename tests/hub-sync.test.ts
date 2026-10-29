import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHub } from "./hub-client/fake-hub";
import { cardData, makeHubClient, projectData, type HubTestClient } from "./hub-client/harness";

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

const seedBoard = () => {
  hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
  hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Ship it") });
};

describe("hub pull", () => {
  it("alice receives the owner's project after one sync", async () => {
    seedBoard();
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p1" } }))?.name).toBe("Atlas");
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Ship it");
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });

  it("a second sync with no news changes nothing", async () => {
    seedBoard();
    await alice.sync();
    const sp = await alice.space("common");
    expect(await alice.engine.pullSpace(sp)).toEqual({ changed: false, applied: 0 });
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("only the latest event per entity is applied", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Ship it v2") });
    await alice.sync();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Ship it v2");
  });

  it("entity delete arrives as tombstone and removes the local row", async () => {
    seedBoard();
    await alice.sync();
    hub.inject("common", { type: "card", id: "c1", deleted: true });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect(await alice.db.project.findUnique({ where: { id: "p1" } })).not.toBeNull();
  });

  it("cursor expiry: pruned history resyncs from the snapshot, absent entities are deleted, cursor equals hub seq", async () => {
    seedBoard();
    await alice.sync();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Second") });
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c3", data: cardData("p1", "Third") });
    hub.pruneBefore(hub.seq("common"));
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c2" } }))?.title).toBe("Second");
    expect(await alice.db.planningItem.findUnique({ where: { id: "c3" } })).not.toBeNull();
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });

  it("a vanished entity with a pending local edit is kept", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Mine" } });
    await alice.engine.capture();
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c9", data: cardData("p1", "Other") });
    hub.pruneBefore(hub.seq("common"));
    await alice.engine.pullSpace(await alice.space("common"));
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Mine");
  });

  it("hub seq lower than local cursor (reset) resyncs from snapshot, no stall", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Two") });
    await alice.sync();
    expect((await alice.space("common")).hubCursor).toBe(3n);
    hub.resetSeq("common", 1n);
    hub.dropEntity("common", "card", "c2");
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c2" } })).toBeNull();
    expect((await alice.space("common")).hubCursor).toBe(1n);
    hub.inject("common", { type: "card", id: "c4", data: cardData("p1", "Four") });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c4" } })).not.toBeNull();
  });

  it("pages through `more` and accumulates", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    for (let i = 0; i < 520; i++) hub.inject("common", { type: "card", id: `c${i}`, data: cardData("p1", `T${i}`) });
    await alice.sync();
    expect(await alice.db.planningItem.count()).toBe(520);
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });
});

describe("hub guards", () => {
  it("a newer schema is blocked, unknown types ignored, others applied, cursor advances", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    hub.inject("common", { type: "card", id: "c1", schema: 2, data: cardData("p1", "Future") });
    hub.inject("common", { type: "hologram", id: "h1", data: { x: 1 } });
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Fine") });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c2" } }))?.title).toBe("Fine");
    const sp = await alice.space("common");
    const se = await alice.db.syncEntity.findUniqueOrThrow({ where: { spaceId_type_entityId: { spaceId: sp.id, type: "card", entityId: "c1" } } });
    expect((se.meta as { newer?: boolean }).newer).toBe(true);
    expect(await alice.db.syncEntity.count({ where: { spaceId: sp.id, type: "hologram" } })).toBe(0);
    expect(sp.hubCursor).toBe(hub.seq("common"));
  });

  it("an entity that throws is retried next pull, cursor held, others applied", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas", "atlas") });
    hub.inject("common", { type: "project", id: "p2", data: projectData("Clash", "atlas") }); // unique slug violation
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Fine") });
    await alice.sync();
    expect(await alice.db.project.findUnique({ where: { id: "p2" } })).toBeNull();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).not.toBeNull();
    let sp = await alice.space("common");
    expect(sp.hubCursor).toBe(1n);
    expect(sp.lastError).toMatch(/^Skipped 1 unreadable entity/);
    hub.inject("common", { type: "project", id: "p2", data: projectData("Clash", "clash") });
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p2" } }))?.slug).toBe("clash");
    sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));
    expect(sp.lastError).toBeNull();
  });

  it("an entity placed in another space is not overwritten from here", async () => {
    await olive.sync();
    await olive.db.project.create({ data: { id: "p1", workspaceId: olive.profile.workspace.id, name: "Mine", slug: "mine", spaceId: (await olive.space("secret")).id } });
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    await olive.engine.pullSpace(await olive.space("common"));
    expect((await olive.db.project.findUnique({ where: { id: "p1" } }))?.name).toBe("Mine");
  });
});

describe("hub access and errors", () => {
  it("a restricted space is absent for a non-member, and answers 404", async () => {
    hub.inject("secret", { type: "project", id: "s1", data: projectData("Secret") });
    await alice.sync();
    expect(await alice.db.space.findFirst({ where: { hubSpaceId: "secret" } })).toBeNull();
    expect(await alice.db.project.findUnique({ where: { id: "s1" } })).toBeNull();
    await expect(alice.client.pull("secret", 0n)).rejects.toMatchObject({ kind: "not-found" });
    await olive.sync();
    expect(await olive.db.project.findUnique({ where: { id: "s1" } })).not.toBeNull();
  });

  it("access removed revokes: rows purged, ops quarantined, space revoked", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Local edit" } });
    await alice.engine.capture();
    hub.removeMember("2");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.access).toBe("REVOKED");
    expect(sp.lastError).toBeTruthy();
    expect(await alice.db.project.count()).toBe(0);
    expect(await alice.db.planningItem.count()).toBe(0);
    const ops = await alice.db.outboxOp.findMany();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.status === "QUARANTINED")).toBe(true);
  });

  it("a space that vanishes from /me is revoked by syncHubSpaces", async () => {
    hub.inject("secret", { type: "project", id: "s1", data: projectData("Secret") });
    await olive.sync();
    hub.deleteSpace("secret");
    await olive.sync();
    expect((await olive.space("secret")).access).toBe("REVOKED");
    expect(await olive.db.project.findUnique({ where: { id: "s1" } })).toBeNull();
  });

  it("network failure: lastError offline, state offline, edits stay pending", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited offline" } });
    hub.failNext(20, "network");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.lastError).toBe("offline");
    expect((await alice.engine.stateFor(sp)).state).toBe("offline");
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("401: sign-in message, ops kept", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    hub.revokeToken("2");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.lastError).toBe("Sign in to the server again");
    expect(sp.access).toBe("OK");
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("429 sets rateLimitedUntil", async () => {
    await alice.sync();
    hub.failNext(1, "rate-limited");
    await alice.engine.pullSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.rateLimitedUntil).not.toBeNull();
    expect((await alice.engine.stateFor(sp)).state).toBe("rate-limited");
  });
});
