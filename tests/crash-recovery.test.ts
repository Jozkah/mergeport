import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { createTask } from "@/lib/services/tasks";
import { clock, makeClient, seedProject, type Client } from "./harness";

let server: FakeGitHubServer;
const clients: Client[] = [];
beforeEach(() => {
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice"]) server.addUser(u);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function team() {
  const olive = await makeClient(server, "olive");
  const alice = await makeClient(server, "alice");
  clients.push(olive, alice);
  const plan = await olive.team.planTeam({ name: "Atlas Crew" });
  const common = await olive.team.createTeam(plan, { confirmed: true });
  await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
  await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
  const seed = await seedProject(olive, common);
  await olive.engine.syncSpace(common);
  const joined = await alice.team.join(plan.fullName, { confirmed: true });
  await alice.engine.syncSpace(joined);
  return { olive, alice, common, joined, seed };
}

describe("recovery after the app stopped while sending (the SENT state)", () => {
  it("an operation orphaned in SENT by a crash is sent again, exactly once, and reaches teammates", async () => {
    const { olive, alice, common, joined, seed } = await team();
    const ov = await olive.viewer();
    const task = await createTask(olive.db, ov, { projectId: seed.project.id, title: "Written just before the crash" });
    await olive.engine.capture();
    const op = await olive.db.outboxOp.findFirstOrThrow({ where: { entityId: task.id } });
    // The process died after marking it SENT and before learning the result: it stays SENT, long ago.
    await olive.db.$executeRawUnsafe(`UPDATE "OutboxOp" SET "status" = 'SENT', "updatedAt" = datetime('now', '-1 hour') WHERE "id" = ?`, op.id);
    await olive.engine.syncSpace(common);
    expect(await olive.db.outboxOp.count({ where: { id: op.id } })).toBe(0);
    await alice.engine.syncSpace(await alice.db.space.findUniqueOrThrow({ where: { id: joined.id } }));
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: task.id } })).title).toBe("Written just before the crash");
    // exactly once: the entity's recorded version is 1, not 2
    expect((await olive.db.syncEntity.findUniqueOrThrow({ where: { spaceId_type_entityId: { spaceId: common.id, type: "card", entityId: task.id } } })).baseVersion).toBe(1);
    expect((await olive.db.space.findUniqueOrThrow({ where: { id: common.id } })).lastPushedAt).toBeInstanceOf(Date);
  });

  it("when the commit had in fact landed before the crash, the retry does not send it a second time", async () => {
    const { olive, common, seed } = await team();
    const ov = await olive.viewer();
    const task = await createTask(olive.db, ov, { projectId: seed.project.id, title: "Landed, then crashed" });
    await olive.engine.syncSpace(common); // published for real
    const se = await olive.db.syncEntity.findUniqueOrThrow({ where: { spaceId_type_entityId: { spaceId: common.id, type: "card", entityId: task.id } } });
    const appliedId = ((se.meta as { applied: string[] }).applied ?? []).at(-1)!;
    // Reconstruct the crash: the outbox still holds the operation as SENT even though the file already records it.
    await olive.db.outboxOp.create({ data: { id: appliedId, spaceId: common.id, entityType: "card", entityId: task.id, kind: "UPSERT", data: {}, status: "SENT" } });
    await olive.db.$executeRawUnsafe(`UPDATE "OutboxOp" SET "updatedAt" = datetime('now', '-1 hour') WHERE "id" = ?`, appliedId);
    const commitsBefore = server.history(common.repoOwner, common.repoName).length;
    await olive.engine.syncSpace(common);
    expect(await olive.db.outboxOp.count({ where: { id: appliedId } })).toBe(0);
    expect(server.history(common.repoOwner, common.repoName).length).toBe(commitsBefore); // nothing was sent again
  });

  it("a SENT operation that is recent is left alone: its commit may still be in flight", async () => {
    const { olive, common, seed } = await team();
    const ov = await olive.viewer();
    const task = await createTask(olive.db, ov, { projectId: seed.project.id, title: "In flight" });
    await olive.engine.capture();
    const op = await olive.db.outboxOp.findFirstOrThrow({ where: { entityId: task.id } });
    await olive.db.outboxOp.update({ where: { id: op.id }, data: { status: "SENT" } });
    await olive.engine.pushSpace(common);
    expect((await olive.db.outboxOp.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("SENT");
  });
});
