import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
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

describe("entities that cannot be applied yet", () => {
  it("are applied on a later poll once their source repository exists, although the coordination head did not change", async () => {
    const olive = await makeClient(server, "olive");
    const alice = await makeClient(server, "alice");
    clients.push(olive, alice);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const seed = await seedProject(olive, common); // the fork repository is shared in the space
    // The upstream repository is tracked on Olive's computer only: it is not part of the space.
    const owner = await olive.db.githubOwner.findFirstOrThrow();
    const upstream = await olive.db.repository.create({ data: { workspaceId: olive.profile.workspace.id, githubId: 999n, ownerId: owner.id, name: "upstream", fullName: "acme/upstream", htmlUrl: "https://github.com/acme/upstream", visibility: "PUBLIC", defaultBranch: "main" } });
    const mapping = await olive.db.forkMapping.create({ data: { forkRepoId: seed.repo.id, upstreamRepoId: upstream.id, forkBranch: "main", upstreamBranch: "main" } });
    await olive.engine.syncSpace(common);

    const joined = await alice.team.join(plan.fullName, { confirmed: true });
    await alice.engine.syncSpace(joined);
    expect(await alice.db.forkMapping.count({ where: { id: mapping.id } })).toBe(0); // deferred: no upstream here yet
    expect((await alice.db.space.findUniqueOrThrow({ where: { id: joined.id } })).deferredCount).toBe(1);

    // Source sync on Alice's computer catches up. The coordination repository itself has not changed.
    const aliceOwner = await alice.db.githubOwner.findFirstOrThrow();
    await alice.db.repository.create({ data: { workspaceId: alice.profile.workspace.id, githubId: 999n, ownerId: aliceOwner.id, name: "upstream", fullName: "acme/upstream", htmlUrl: "https://github.com/acme/upstream", visibility: "PUBLIC", defaultBranch: "main" } });
    await alice.engine.syncSpace(await alice.db.space.findUniqueOrThrow({ where: { id: joined.id } }));
    expect(await alice.db.forkMapping.count({ where: { id: mapping.id } })).toBe(1);
    expect((await alice.db.space.findUniqueOrThrow({ where: { id: joined.id } })).deferredCount).toBe(0);
  });
});
