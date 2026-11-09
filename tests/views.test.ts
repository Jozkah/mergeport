import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { cleanQuery, deleteView, listViews, saveView, setViewShared, viewHref } from "@/lib/services/views";
import { clock, makeClient, type Client } from "./harness";
import { freshSeed } from "./helpers";

describe("saved view definitions", () => {
  it("keeps only plain key=value pairs and bounds their size", () => {
    expect(cleanQuery("?state=OPEN&q=bug&bad key=1&x=" + "a".repeat(300) + "&javascript:alert=1")).toBe("state=OPEN&q=bug");
    expect(viewHref("tasks", "scope=mine")).toBe("/tasks?scope=mine");
    expect(viewHref("attention", "")).toBe("/attention");
  });

  it("saves per page, rejects unknown pages, empty and duplicate names, and deletes only the owner's", async () => {
    const { db, a, b } = await freshSeed();
    await expect(saveView(db, a, { scope: "evil", name: "x", query: "" })).rejects.toThrow(/cannot have/);
    await expect(saveView(db, a, { scope: "tasks", name: " ", query: "" })).rejects.toThrow(/Name/);
    const v = await saveView(db, a, { scope: "tasks", name: "Mine open", query: "scope=mine&junk key=1" });
    expect(v.query).toBe("scope=mine");
    await expect(saveView(db, a, { scope: "tasks", name: "Mine open", query: "" })).rejects.toThrow(/already/);
    expect((await listViews(db, a, "tasks")).map((x) => x.href)).toEqual(["/tasks?scope=mine"]);
    expect(await listViews(db, b, "tasks")).toEqual([]);
    await expect(deleteView(db, b, v.id)).rejects.toThrow();
    await setViewShared(db, a, v.id, true);
    expect((await listViews(db, a, "tasks"))[0].shared).toBe(true);
    await deleteView(db, a, v.id);
    expect(await listViews(db, a, "tasks")).toEqual([]);
  });
});

describe("shared views across computers", () => {
  let server: FakeGitHubServer;
  const clients: Client[] = [];
  beforeEach(() => {
    server = new FakeGitHubServer(() => clock.t);
    for (const u of ["olive", "alice"]) server.addUser(u);
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it("a shared view arrives as a definition, can be removed by its owner, and is never editable by the recipient", async () => {
    const olive = await makeClient(server, "olive");
    const alice = await makeClient(server, "alice");
    clients.push(olive, alice);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const joined = await alice.team.join(plan.fullName, { confirmed: true });
    const ov = await olive.viewer();
    const mine = await saveView(olive.db, ov, { scope: "attention", name: "Release blockers", query: "queue=blocked", shared: true });
    await saveView(olive.db, ov, { scope: "attention", name: "Private", query: "queue=team" });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(joined);
    const av = await alice.viewer();
    const got = await listViews(alice.db, av, "attention");
    expect(got.map((g) => g.name)).toEqual(["Release blockers"]); // the private view did not travel
    expect(got[0]).toMatchObject({ shared: true, mine: false, ownerLogin: "olive", href: "/attention?queue=blocked" });
    await expect(deleteView(alice.db, av, mine.id)).rejects.toThrow(/only they can/);
    await setViewShared(olive.db, ov, mine.id, false);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(await alice.db.space.findFirstOrThrow({ where: { remoteId: common.remoteId } }));
    expect(await listViews(alice.db, av, "attention")).toEqual([]);
  });
});
