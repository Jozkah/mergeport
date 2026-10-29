import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { leaveTeamLocally } from "@/lib/team/leave";
import { clock, makeClient, seedProject, type Client } from "./harness";

let server: FakeGitHubServer;
let clients: Client[] = [];
beforeEach(() => {
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice"]) server.addUser(u);
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function team() {
  const olive = await makeClient(server, "olive");
  const alice = await makeClient(server, "alice");
  clients.push(olive, alice);
  const plan = await olive.team.planTeam({ name: "Atlas Crew" });
  const common = await olive.team.createTeam(plan, { confirmed: true });
  await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
  await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
  await alice.team.join(plan.fullName, { confirmed: true });
  return { olive, alice, common };
}

describe("losing a space", () => {
  it("never erases the data an admin created: it becomes local again", async () => {
    const { olive, common } = await team();
    const seed = await seedProject(olive, common);
    await olive.engine.revokeSpace(common.id, "repository renamed");
    expect(await olive.db.repository.findUnique({ where: { id: seed.repo.id } })).toMatchObject({ spaceId: null });
    expect(await olive.db.project.findUnique({ where: { id: seed.project.id } })).toMatchObject({ spaceId: null });
    expect(await olive.db.planningItem.count({ where: { projectId: seed.project.id } })).toBe(1);
  });

  it("still removes a member's cached copy when their access is taken away", async () => {
    const { olive, alice, common } = await team();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    const aliceCommon = await alice.db.space.findFirstOrThrow({ where: { remoteId: common.remoteId } });
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(1);
    await alice.engine.revokeSpace(aliceCommon.id, "removed");
    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(0);
  });

  it("leaving a team keeps projects, cards and repositories", async () => {
    const { olive, common } = await team();
    const seed = await seedProject(olive, common);
    await leaveTeamLocally(olive.db);
    expect(await olive.db.repository.count({ where: { id: seed.repo.id } })).toBe(1);
    expect(await olive.db.project.count({ where: { id: seed.project.id } })).toBe(1);
    expect(await olive.db.planningItem.count({ where: { projectId: seed.project.id } })).toBe(1);
  });
});

describe("a new computer finds its team", () => {
  it("lists the accepted invitation's space before anything is joined, then joins and receives the shared data", async () => {
    const olive = await makeClient(server, "olive");
    const alice = await makeClient(server, "alice");
    clients.push(olive, alice);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);

    const found = await alice.team.candidates();
    expect(found.map((c) => c.fullName)).toContain(plan.fullName);
    expect(await alice.db.space.count()).toBe(0); // nothing joined yet

    const joined = await alice.team.join(plan.fullName, { confirmed: true });
    await alice.engine.syncSpace(joined);
    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(1);
    expect(await alice.db.planningItem.count({ where: { projectId: seed.project.id } })).toBe(1);
  });
});
