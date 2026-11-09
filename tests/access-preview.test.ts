import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { accessPreview, spaceContents } from "@/lib/services/access-preview";
import { createTask } from "@/lib/services/tasks";
import { clock, makeClient, seedProject, type Client } from "./harness";

let server: FakeGitHubServer;
const clients: Client[] = [];
beforeEach(() => {
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice", "bram"]) server.addUser(u);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("access preview", () => {
  it("lists what a space shares and separately checks each person's source-repository access", async () => {
    const olive = await makeClient(server, "olive");
    clients.push(olive);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    const seed = await seedProject(olive, common, { repoFullName: "olive/secret-repo", project: "Secret Project" });
    const ov = await olive.viewer();
    await createTask(olive.db, ov, { projectId: seed.project.id, title: "Rotate the signing keys" });
    // The source repository exists on GitHub; only bram can read it.
    await olive.fetch("https://api.github.com/user/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "secret-repo", private: true }) });
    server.repo("olive", "secret-repo")!.collaborators.set("bram", "pull");
    await olive.engine.syncSpace(common);

    const c = await spaceContents(olive.db, ov, common.id);
    expect(c.repositories.map((r) => r.fullName)).toEqual(["olive/secret-repo"]);
    expect(c.projects).toEqual([{ name: "Secret Project", cards: 2 }]);
    expect(c.tasks.titles).toContain("Rotate the signing keys");
    expect(c.history.note).toMatch(/commit message/);

    const p = await accessPreview(olive.db, ov, { spaceId: common.id, logins: ["@bram", "alice"], permission: "push" }, (repo, login) => olive.team.sourcePermission(repo, login));
    const bram = p.people.find((x) => x.login === "bram")!;
    const alice = p.people.find((x) => x.login === "alice")!;
    expect(bram.source).toEqual([{ repo: "olive/secret-repo", permission: "read" }]);
    expect(bram.missing).toEqual([]);
    expect(alice.source).toEqual([{ repo: "olive/secret-repo", permission: "none" }]);
    expect(alice.missing).toEqual(["olive/secret-repo"]);
    expect(alice.coordination.level).toBe("write");
    expect(p.notes[0]).toMatch(/Hiding something in the screens/);
  });

  it("reports unknown, not none, when GitHub cannot be asked, and is for administrators only", async () => {
    const olive = await makeClient(server, "olive");
    clients.push(olive);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    const ov = await olive.viewer();
    const p = await accessPreview(olive.db, ov, { spaceId: common.id, logins: ["alice"], permission: "pull" }, async () => {
      throw new Error("offline");
    });
    expect(p.people[0].source).toEqual([]);
    expect(await olive.team.sourcePermission("olive/missing-repo", "alice")).toBe("unknown"); // the repository cannot be read, so the answer is unknown
    await expect(spaceContents(olive.db, { ...ov, isAdmin: false }, common.id)).rejects.toThrow(/administrator/);
    await expect(accessPreview(olive.db, ov, { spaceId: common.id, logins: [], permission: "push" }, async () => "none")).rejects.toThrow(/at least one/);
  });
});
