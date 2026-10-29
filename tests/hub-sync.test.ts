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

const cardKey = (spaceId: string, id = "c1") => ({ spaceId_type_entityId: { spaceId, type: "card", entityId: id } });
const title = async (c: HubTestClient, id = "c1") => (await c.db.planningItem.findUnique({ where: { id } }))?.title;

describe("hub push", () => {
  it("edit on olive reaches alice through push + pull (outbox empty, hub entity version 1)", async () => {
    await olive.sync();
    const sp = await olive.space("common");
    await olive.db.project.create({ data: { id: "p9", workspaceId: olive.profile.workspace.id, name: "Nine", slug: "nine", spaceId: sp.id } });
    await olive.sync();
    expect(hub.entity("common", "project", "p9")?.version).toBe(1);
    expect(await olive.db.outboxOp.count()).toBe(0);
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p9" } }))?.name).toBe("Nine");
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("concurrent edits to DIFFERENT entities: both applied, no stale, no conflict", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Second") });
    await olive.sync();
    await alice.sync();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "O1" } });
    await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: "A2" } });
    await olive.sync();
    await alice.sync();
    await olive.sync();
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
    expect(hub.entity("common", "card", "c2")?.version).toBe(2);
    expect(await title(olive, "c2")).toBe("A2");
    expect(await title(alice, "c1")).toBe("O1");
    expect(await olive.db.syncConflict.count()).toBe(0);
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("same entity, different fields: one stale, three-way merged, retried in the same cycle, both fields present on both clients after sync, no SyncConflict", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { priority: 2 } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "O1" } });
    await olive.sync();
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 1 });
    expect(hub.opsRequests - before).toBe(2); // stale, then the merged retry
    await olive.sync();
    await alice.sync();
    for (const c of [olive, alice]) {
      const row = await c.db.planningItem.findUniqueOrThrow({ where: { id: "c1" } });
      expect(row.title).toBe("O1");
      expect(row.priority).toBe(2);
      expect(await c.db.syncConflict.count()).toBe(0);
      expect(await c.db.outboxOp.count()).toBe(0);
    }
    expect(hub.entity("common", "card", "c1")?.version).toBe(3);
  });

  it("same field: SyncConflict OPEN with that field, op CONFLICT, nothing sent until resolveConflict(..., \"mine\")", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Alice" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Olive" } });
    await olive.sync();
    const sp = await alice.space("common");
    await alice.engine.pushSpace(sp);
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["title"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 0 });
    expect(hub.opsRequests).toBe(before);
    expect(hub.entity("common", "card", "c1")?.data.title).toBe("Olive");
    await alice.engine.resolveConflict(c.id, "mine");
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 1 });
    expect(hub.entity("common", "card", "c1")?.data.title).toBe("Alice");
    await olive.sync();
    expect(await title(olive)).toBe("Alice");
  });

  it("lost response (hub.dropNextResponse()): first push throws network, ops back to PENDING, second push gets duplicate, hub applied once (version 1), op gone, base correct", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Lost" } });
    await alice.engine.capture();
    hub.dropNextResponse();
    const sp = await alice.space("common");
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 0 });
    const op = await alice.db.outboxOp.findFirstOrThrow();
    expect(op.status).toBe("PENDING");
    expect(op.error).toBeTruthy();
    expect(hub.entity("common", "card", "c1")?.version).toBe(2); // applied exactly once (v1 was the seed)
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 0 });
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
    expect(await alice.db.outboxOp.count()).toBe(0);
    const se = await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) });
    expect(se.baseVersion).toBe(2);
    expect((se.baseData as { title: string }).title).toBe("Lost");
    expect((se.meta as { applied: string[] }).applied).toContain(op.id);
  });

  it("duplicate with a newer remote version leaves base untouched and a later pull converges", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Mine" } });
    await alice.engine.capture();
    hub.dropNextResponse();
    await alice.engine.pushSpace(await alice.space("common"));
    hub.inject("common", { type: "card", id: "c1", data: { ...cardData("p1", "Mine"), priority: 5 } }); // v3
    const sp = await alice.space("common");
    await alice.engine.pushSpace(sp);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect((await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) })).baseVersion).toBe(1);
    await alice.sync();
    expect((await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) })).baseVersion).toBe(3);
    const row = await alice.db.planningItem.findUniqueOrThrow({ where: { id: "c1" } });
    expect([row.title, row.priority]).toEqual(["Mine", 5]);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c1")?.version).toBe(3);
  });

  it("remote edit vs local delete: conflict with fields [\"__deleted\"]", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.delete({ where: { id: "c1" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    await olive.sync();
    await alice.engine.pushSpace(await alice.space("common"));
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["__deleted"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(false);
  });

  it("local edit vs remote delete: conflict with fields [\"__deleted\"]", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    await alice.engine.capture();
    await olive.db.planningItem.delete({ where: { id: "c1" } });
    await olive.sync();
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(true);
    await alice.engine.pushSpace(await alice.space("common"));
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["__deleted"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
  });

  it("offline queue: hub stopped, three edits captured and stay PENDING; hub restarted, one sync sends them all", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Two") });
    hub.inject("common", { type: "card", id: "c3", data: cardData("p1", "Three") });
    await alice.sync();
    await hub.close();
    for (const id of ["c1", "c2", "c3"]) await alice.db.planningItem.update({ where: { id }, data: { title: `Off ${id}` } });
    await alice.sync();
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(3);
    expect((await alice.space("common")).lastError).toBe("offline");
    await hub.restart();
    const before = hub.opsRequests;
    await alice.sync();
    expect(hub.opsRequests - before).toBe(1);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c3")?.data.title).toBe("Off c3");
  });

  it("three-round cap: hub.alwaysStale(entity) leaves ops PENDING after exactly 3 push requests", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Hot" } });
    await alice.engine.capture();
    hub.alwaysStale("common", "card", "c1");
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 0 });
    expect(hub.opsRequests - before).toBe(3);
    const ops = await alice.db.outboxOp.findMany();
    expect(ops.map((o) => o.status)).toEqual(["PENDING"]);
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("write forbidden (member demoted to READER) -> ops QUARANTINED, canWrite false", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Nope" } });
    await alice.engine.capture();
    hub.setRole("2", "READER");
    await alice.engine.pushSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.canWrite).toBe(false);
    expect(sp.access).toBe("OK");
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("QUARANTINED");
    expect(hub.entity("common", "card", "c1")?.version).toBe(1);
  });

  it("delete is pushed as DELETE op and arrives as tombstone", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.delete({ where: { id: "c1" } });
    await alice.sync();
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(true);
    expect(await alice.db.outboxOp.count()).toBe(0);
    await olive.sync();
    expect(await olive.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
  });

  it("a snapshot resync keeps a vanished entity that has a CONFLICT op", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Alice" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Olive" } });
    await olive.sync();
    await alice.engine.pushSpace(await alice.space("common"));
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c9", data: cardData("p1", "Other") });
    hub.pruneBefore(hub.seq("common"));
    await alice.engine.pullSpace(await alice.space("common"));
    expect(await title(alice)).toBe("Alice");
    expect(await alice.db.syncConflict.count({ where: { status: "OPEN" } })).toBe(1);
  });
});
