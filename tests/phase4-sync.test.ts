import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { addMapping } from "@/lib/services/label-taxonomy";
import { createSubscription } from "@/lib/services/upstream-extras";
import { createTask } from "@/lib/services/tasks";
import { setTaskBranch } from "@/lib/services/work-links";
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

describe("label mappings, subscriptions and branch names across computers", () => {
  it("arrive on a teammate's computer; paths and personal drafts never travel", async () => {
    const olive = await makeClient(server, "olive");
    const alice = await makeClient(server, "alice");
    clients.push(olive, alice);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const seed = await seedProject(olive, common);
    const ov = await olive.viewer();
    const m = await addMapping(olive.db, ov, { concept: "priority::high", spelling: "P1" });
    const s = await createSubscription(olive.db, ov, { name: "Security", criteria: { labels: ["security"] } });
    const t = await createTask(olive.db, ov, { projectId: seed.project.id, title: "Work" });
    await setTaskBranch(olive.db, ov, t.id, "fix-login");
    await olive.db.reviewDraft.create({ data: { userId: olive.profile.user.id, workItemId: "w", path: "p", line: 1, body: "private draft", commitSha: "x" } });
    await olive.engine.syncSpace(common);
    const joined = await alice.team.join(plan.fullName, { confirmed: true });
    await alice.engine.syncSpace(joined);
    expect(await alice.db.labelMap.findUnique({ where: { id: m.id } })).toMatchObject({ concept: "priority::high", spelling: "P1" });
    expect(await alice.db.upstreamSubscription.findUnique({ where: { id: s.id } })).toMatchObject({ name: "Security" });
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: t.id } })).branchRef).toBe("fix-login");
    expect(await alice.db.reviewDraft.count()).toBe(0);
  });
});
