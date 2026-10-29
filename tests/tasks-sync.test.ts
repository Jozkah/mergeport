import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { addComment, createTask, updateTask } from "@/lib/services/tasks";
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

describe("tasks across computers", () => {
  it("a task assigned to a teammate, with its discussion, arrives on the teammate's computer", async () => {
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

    const viewer = { userId: olive.profile.user.id, memberId: olive.profile.member.id, workspaceId: olive.profile.workspace.id, login: "olive", githubId: 1n, timezone: "UTC", isAdmin: true };
    const task = await createTask(olive.db, viewer, { projectId: seed.project.id, title: "Rotate the keys", assigneeLogin: "alice", labels: "security", priority: 3 });
    await addComment(olive.db, viewer, task.id, "Please do this before friday");
    await updateTask(olive.db, viewer, task.id, { columnKey: "in-progress" });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(await alice.db.space.findFirstOrThrow({ where: { remoteId: common.remoteId } }));

    const got = await alice.db.planningItem.findUniqueOrThrow({ where: { id: task.id }, include: { column: true, comments: { orderBy: { createdAt: "asc" } } } });
    expect(got).toMatchObject({ title: "Rotate the keys", assigneeLogin: "alice", assignedByLogin: "olive", authorLogin: "olive", priority: 3, labels: ["security"] });
    expect(got.column.key).toBe("in-progress");
    expect(got.comments.map((c) => c.kind)).toContain("COMMENT");
    expect(got.comments.find((c) => c.kind === "COMMENT")?.body).toBe("Please do this before friday");
  });
});
