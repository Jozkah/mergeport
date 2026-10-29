import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { assignEpic, assignIteration, createBoard, createEpic, createIteration } from "@/lib/services/planning-ext";
import { addDependency } from "@/lib/services/planning";
import { createTask, updateTask } from "@/lib/services/tasks";
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

describe("boards, epics, iterations, link kinds and history across computers", () => {
  it("arrive on a teammate's computer together with the cards they group", async () => {
    const olive = await makeClient(server, "olive");
    const alice = await makeClient(server, "alice");
    clients.push(olive, alice);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const seed = await seedProject(olive, common);
    const ov = await olive.viewer();
    const p = seed.project.id;
    const a = await createTask(olive.db, ov, { projectId: p, title: "A" });
    const b = await createTask(olive.db, ov, { projectId: p, title: "B" });
    const epic = await createEpic(olive.db, ov, { projectId: p, title: "Hardening" });
    const iter = await createIteration(olive.db, ov, { projectId: p, name: "Week 1", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-08T00:00:00Z") });
    await assignEpic(olive.db, ov, a.id, epic.id);
    await assignIteration(olive.db, ov, a.id, iter.id);
    await addDependency(olive.db, ov, a.id, b.id, "related");
    const board = await createBoard(olive.db, ov, { projectId: p, template: "delivery" });
    await updateTask(olive.db, ov, b.id, { columnKey: "in-progress" });
    await olive.engine.syncSpace(common);
    const joined = await alice.team.join(plan.fullName, { confirmed: true });
    await alice.engine.syncSpace(joined);

    expect(await alice.db.epic.findUnique({ where: { id: epic.id } })).toMatchObject({ title: "Hardening" });
    expect(await alice.db.iteration.findUnique({ where: { id: iter.id } })).toMatchObject({ name: "Week 1" });
    expect(await alice.db.planBoard.findUnique({ where: { id: board.id } })).toMatchObject({ name: "Delivery" });
    expect(await alice.db.planningItem.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ epicId: epic.id, iterationId: iter.id });
    expect(await alice.db.planningLink.findUnique({ where: { fromId_toId: { fromId: a.id, toId: b.id } } })).toMatchObject({ kind: "related" });
    // History travelled too, and was not recorded a second time on arrival.
    const mine = await olive.db.planEvent.count();
    expect(await alice.db.planEvent.count()).toBe(mine);
  });
});
