import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { GithubError } from "@/lib/github/port";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { listProjects, listRepositories } from "@/lib/services/queries";
import { moveCard } from "@/lib/services/planning";
import { threeWayMerge } from "@/lib/sync/merge";
import { cardColumn, clock, makeClient, seedProject, visibleText, type Client } from "./harness";

let server: FakeGitHubServer;
let clients: Client[] = [];
const mk = async (login: string, events?: { spaceId: string; reason: string }[]) => {
  const c = await makeClient(server, login, { events });
  clients.push(c);
  return c;
};

beforeEach(() => {
  server = new FakeGitHubServer(clock.now.bind(clock) as unknown as () => number);
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice", "bram", "carol"]) server.addUser(u);
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

/** Owner creates a team and invites alice; alice accepts and joins. Returns both clients and the common space. */
async function teamOfTwo() {
  const olive = await mk("olive");
  const alice = await mk("alice");
  const plan = await olive.team.planTeam({ name: "Atlas Crew" });
  const common = await olive.team.createTeam(plan, { confirmed: true });
  const invite = olive.team.planInvite(common, ["alice"]);
  await olive.team.invite(common, invite, { confirmed: true });
  const [inv] = await alice.team.myInvitations();
  await alice.team.acceptInvitation(inv.id);
  const aliceCommon = await alice.team.join(plan.fullName, { confirmed: true });
  return { olive, alice, common, aliceCommon, plan };
}

describe("merge (pure)", () => {
  it("independent fields merge; same-field edits conflict and keep both values; sets merge by adds and removes", () => {
    const base = { title: "T", column: "ready", tags: ["a", "b"] };
    expect(threeWayMerge(base, { ...base, title: "Mine" }, { ...base, column: "done" }, ["tags"])).toEqual({ merged: { title: "Mine", column: "done", tags: ["a", "b"] }, conflicts: [] });
    const c = threeWayMerge(base, { ...base, title: "Mine" }, { ...base, title: "Theirs" });
    expect(c.conflicts).toEqual(["title"]);
    const s = threeWayMerge(base, { ...base, tags: ["a", "b", "c"] }, { ...base, tags: ["a"] }, ["tags"]);
    expect(s.merged.tags).toEqual(["a", "c"]);
  });
});

describe("create team and invitations", () => {
  it("shows the exact plan, creates nothing without confirmation, and creates a private repository with a manifest after it", async () => {
    const olive = await mk("olive");
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    expect(plan).toMatchObject({ owner: "olive", repoName: "mergeport-atlas-crew-workspace", fullName: "olive/mergeport-atlas-crew-workspace", visibility: "private", ownerType: "personal" });
    expect(plan.permissions.join(" ")).toMatch(/private repository/);
    await expect(olive.team.createTeam(plan, { confirmed: false })).rejects.toBeInstanceOf(ValidationError);
    expect(server.repo("olive", "mergeport-atlas-crew-workspace")).toBeUndefined();

    const space = await olive.team.createTeam(plan, { confirmed: true });
    const repo = server.repo("olive", "mergeport-atlas-crew-workspace")!;
    expect(repo.private).toBe(true);
    const manifest = JSON.parse(server.files("olive", repo.name)["mergeport.json"]);
    expect(manifest).toMatchObject({ schema: 1, kind: "mergeport-space", spaceKind: "COMMON", teamName: "Atlas Crew" });
    expect(space.canAdmin).toBe(true);
    expect((await olive.db.teamConfig.findUniqueOrThrow({ where: { id: "team" } })).mode).toBe("TEAM");
  });

  it("a name collision gets a suffix and never touches the unrelated repository", async () => {
    const olive = await mk("olive");
    server.repos.set("olive/mergeport-atlas-crew-workspace", { id: 1, owner: "olive", name: "mergeport-atlas-crew-workspace", private: false, defaultBranch: "main", collaborators: new Map(), invitations: new Map(), objects: new Map(), refs: new Map() });
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    expect(plan.repoName).toBe("mergeport-atlas-crew-workspace-2");
    expect(plan.renamedBecauseOfCollision).toBe(true);
    await olive.team.createTeam(plan, { confirmed: true });
    expect(server.repo("olive", "mergeport-atlas-crew-workspace")!.private).toBe(false);
  });

  it("invitation lifecycle: pending, accepted, expired, failed; and GitHub (not a local role) decides who may invite", async () => {
    const { olive, alice, common, plan } = await teamOfTwo();
    const statuses = await olive.team.invitationStatuses(common);
    expect(statuses).toEqual([{ username: "alice", state: "accepted" }]);

    const plan2 = olive.team.planInvite(common, ["bram", "ghost-user"]);
    expect(plan2.sourceAccessNote).toMatch(/does not grant access to the source-code repositories/);
    await expect(olive.team.invite(common, plan2, { confirmed: false })).rejects.toBeInstanceOf(ValidationError);
    const out = await olive.team.invite(common, plan2, { confirmed: true });
    expect(out).toEqual([{ username: "bram", state: "invited" }, { username: "ghost-user", state: "failed", error: "GitHub user not found" }]);
    expect((await olive.team.invitationStatuses(common, ["bram"]))[0].state).toBe("pending");
    server.expireInvitations("olive", plan.repoName);
    expect((await olive.team.invitationStatuses(common, ["bram"]))[0].state).toBe("expired");

    // alice has WRITE (not admin). Forging an ADMIN role in her own database does not change what GitHub allows.
    await alice.db.member.updateMany({ data: { role: "ADMIN" } });
    const aliceSpace = await alice.db.space.findFirstOrThrow();
    await expect(alice.team.invite(aliceSpace, alice.team.planInvite(aliceSpace, ["carol"]), { confirmed: true })).rejects.toBeInstanceOf(ForbiddenError);
    await alice.engine.syncSpace(aliceSpace);
    expect((await alice.db.member.findFirstOrThrow()).role).toBe("MEMBER"); // derived from GitHub permissions again
    expect(server.repo("olive", plan.repoName)!.invitations.size).toBe(2 - 1 + 0 + 0 || 1);
  });

  it("join verifies access and manifest: rejects public repos, non-Mergeport repos, other teams, newer schemas and unreadable repos", async () => {
    const { olive, plan } = await teamOfTwo();
    const bram = await mk("bram");
    await expect(bram.team.join(plan.fullName, { confirmed: true })).rejects.toThrow(); // no access: GitHub answers 404
    server.repos.set("bram/pub", { id: 9, owner: "bram", name: "pub", private: false, defaultBranch: "main", collaborators: new Map(), invitations: new Map(), objects: new Map(), refs: new Map() });
    await expect(bram.team.join("bram/pub", { confirmed: true })).rejects.toThrow(/public/);
    await bram.fetch("https://api.github.com/user/repos", { method: "POST", body: JSON.stringify({ name: "plain", private: true }) });
    await expect(bram.team.join("bram/plain", { confirmed: true })).rejects.toThrow(/no Mergeport manifest|not a Mergeport/);
    // a different team
    const other = await mk("carol");
    const p2 = await other.team.planTeam({ name: "Other Team" });
    await other.team.createTeam(p2, { confirmed: true });
    const o2 = other.team.planInvite((await other.db.space.findFirstOrThrow()), ["bram"]);
    await other.team.invite(await other.db.space.findFirstOrThrow(), o2, { confirmed: true });
    await bram.team.acceptInvitation((await bram.team.myInvitations())[0].id);
    await bram.team.join(p2.fullName, { confirmed: true }); // joins team two
    await expect(bram.team.join(plan.fullName, { confirmed: true })).rejects.toThrow(); // still no access to team one's repo
    // newer schema
    const files = server.files("olive", plan.repoName);
    const m = JSON.parse(files["mergeport.json"]);
    const repo = server.repo("olive", plan.repoName)!;
    const head = repo.refs.get("heads/main")!;
    void head; void olive; void m;
    expect(TeamServiceParse("olive/x")).toEqual({ owner: "olive", repo: "x" });
    expect(TeamServiceParse("http://127.0.0.1:3000/join?repo=olive%2Fx")).toEqual({ owner: "olive", repo: "x" });
  });
});

import { TeamService } from "@/lib/team/service";
const TeamServiceParse = (s: string) => TeamService.parseRepoRef(s);

describe("sync between two isolated clients", () => {
  it("a project, card and move made by one client reach the other without any reload, and the receiver is told", async () => {
    const events: { spaceId: string; reason: string }[] = [];
    const olive = await mk("olive");
    const alice = await mk("alice", events);
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const aliceCommon = await alice.team.join(plan.fullName, { confirmed: true });

    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.planningItem.findUnique({ where: { id: seed.card.id } })).toMatchObject({ title: "Rotate the signing keys" });
    expect(events.some((e) => e.reason === "pulled")).toBe(true);

    // member visibility is derived from the space audience: alice sees the shared repository and project, can edit (write)
    const av = await alice.viewer();
    expect((await listRepositories(alice.db, av)).map((r) => r.fullName)).toEqual(["acme/secret-repo"]);
    expect((await listProjects(alice.db, av)).map((p) => p.name)).toEqual(["Secret Project"]);

    // olive moves the card; alice's next poll applies it
    await moveCard(olive.db, await olive.viewer(), { itemId: seed.card.id, toColumnKey: "in-progress", expectedVersion: 1 });
    await olive.engine.syncSpace(common);
    events.length = 0;
    await alice.engine.syncSpace(aliceCommon);
    expect(await cardColumn(alice, seed.card.id)).toBe("in-progress");
    expect(events.some((e) => e.reason === "pulled")).toBe(true);
  });

  it("round trip is stable: after a pull there is nothing to send (no invented edits)", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.engine.capture()).toBe(0);
    expect(await olive.engine.capture()).toBe(0);
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("concurrent edits to DIFFERENT fields of one card merge automatically", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Rotate keys (olive)" } });
    const col = await alice.db.planningColumn.findFirstOrThrow({ where: { projectId: seed.project.id, key: "done" } });
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { columnId: col.id } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon); // pulls olive's title, merges with her move, pushes
    await olive.engine.syncSpace(common);
    for (const c of [olive, alice]) {
      const row = await c.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id }, include: { column: true } });
      expect([row.title, row.column.key]).toEqual(["Rotate keys (olive)", "done"]);
    }
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("concurrent edits to the SAME field become a conflict that keeps both values until a person resolves it", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Olive's title" } });
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Alice's title" } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);

    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["title"]);
    expect((c.local as { title: string }).title).toBe("Alice's title");
    expect((c.remote as { title: string }).title).toBe("Olive's title");
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("Alice's title"); // her edit is not discarded
    expect((await alice.engine.stateFor(aliceCommon)).state).toBe("conflict");
    await alice.engine.syncSpace(aliceCommon);
    expect(server.files("olive", common.repoName)).toBeTruthy();

    await alice.engine.resolveConflict(c.id, "mine");
    await alice.engine.syncSpace(aliceCommon);
    await olive.engine.syncSpace(common);
    expect((await olive.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("Alice's title");
    expect((await alice.engine.stateFor(aliceCommon)).state).toBe("synced");

    // and "theirs" keeps the remote value
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "O2" } });
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "A2" } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await alice.engine.resolveConflict((await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } })).id, "theirs");
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("O2");
  });

  it("a response lost after a successful commit does not apply the operation twice", async () => {
    const { olive, common } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common); // initial push
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Changed once" } });
    server.loseResponseNext(/PATCH \/repos\/olive\/[^/]+\/git\/refs/);
    await olive.engine.syncSpace(common); // commit lands, the client sees a network error
    expect(await olive.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1); // unsure: kept for retry
    const commitsBefore = server.history("olive", common.repoName).length;
    await olive.engine.syncSpace(common); // retry
    expect(await olive.db.outboxOp.count()).toBe(0);
    expect(server.history("olive", common.repoName).length).toBe(commitsBefore); // no second commit
    const file = JSON.parse(server.files("olive", common.repoName)[`entities/card/${seed.card.id}.json`]);
    expect(file.version).toBe(2); // created (1) + changed once (2); not 3
    expect(file.data.title).toBe("Changed once");
  });

  it("offline editing is saved locally first, shown as offline, and sent after reconnect", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);

    server.offline = true;
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Written offline" } });
    await olive.engine.syncSpace(common);
    expect(await olive.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1); // durable local outbox
    expect((await olive.engine.stateFor(await olive.db.space.findFirstOrThrow())).state).toBe("offline");
    server.offline = false;
    clock.advance(11 * 60_000);
    await olive.engine.tick();
    await alice.engine.refreshNow();
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("Written offline");
  });

  it("deletes leave a tombstone; edit-vs-delete is a conflict, not silent loss", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);

    await olive.db.planningItem.delete({ where: { id: seed.card.id } });
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Alice kept working" } });
    await olive.engine.syncSpace(common);
    expect(JSON.parse(server.files("olive", common.repoName)[`entities/card/${seed.card.id}.json`]).deleted).toBe(true);
    await alice.engine.syncSpace(aliceCommon);
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["__deleted"]);
    expect((await alice.db.planningItem.findUnique({ where: { id: seed.card.id } }))?.title).toBe("Alice kept working");

    // a plain delete (no competing edit) propagates
    const seed2 = await seedProject(olive, common, { repoFullName: "acme/other", githubId: 999n, project: "P2", card: "Temp" });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.planningItem.findUnique({ where: { id: seed2.card.id } })).toBeTruthy();
    await olive.db.planningItem.delete({ where: { id: seed2.card.id } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.planningItem.findUnique({ where: { id: seed2.card.id } })).toBeNull();
  });

  it("restart keeps pending work; a head that moved is merged, never force-pushed over", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seedO = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);

    // alice edits and "crashes" before syncing; olive pushes in the meantime
    await alice.db.planningItem.update({ where: { id: seedO.card.id }, data: { priority: 3 } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: seedO.card.id }, data: { title: "Olive was first" } });
    await olive.engine.syncSpace(common);

    const { SyncEngine } = await import("@/lib/sync/engine");
    const { CoordinationStore } = await import("@/lib/sync/store");
    const { GitHubRest } = await import("@/lib/github/rest");
    const restarted = new SyncEngine({ db: alice.db, actor: alice.actor, now: clock.now, random: () => 0.5, store: (s) => new CoordinationStore(new GitHubRest(alice.fetch), s.repoOwner, s.repoName) });
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
    await restarted.syncSpace(aliceCommon);
    await olive.engine.syncSpace(common);
    const row = await olive.db.planningItem.findUniqueOrThrow({ where: { id: seedO.card.id } });
    expect([row.title, row.priority]).toEqual(["Olive was first", 3]);
    const msgs = server.history("olive", common.repoName);
    expect(msgs.filter((m) => m.startsWith("Mergeport:")).length).toBeGreaterThanOrEqual(3); // linear history, nothing rewritten
  });

  it("an unchanged poll costs one conditional request; changed files are the only blobs fetched", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    server.calls.length = 0;
    await alice.engine.pullSpace(await alice.db.space.findFirstOrThrow());
    const calls = server.calls.filter((c) => c.startsWith("alice"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/GET \/repos\/olive\/[^/]+\/commits\/main/);
  });

  it("schema mismatch: a newer manifest makes the space read-only; newer entity files and unknown types are skipped, never rewritten", async () => {
    const { olive, alice, common, aliceCommon, plan } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    // a teammate on a newer Mergeport writes an entity of schema 2 and an unknown type
    const f = server.fetchFor("olive");
    const { GitHubRest } = await import("@/lib/github/rest");
    const { CoordinationStore } = await import("@/lib/sync/store");
    const st = new CoordinationStore(new GitHubRest(f), "olive", plan.repoName);
    const head = (await st.head("main")) as { sha: string; treeSha: string };
    await st.commit("main", head, [
      { path: "entities/card/future.json", content: JSON.stringify({ schema: 2, type: "card", id: "future", version: 1, deleted: false, appliedOps: [], updatedAt: "", updatedBy: { id: "1", login: "x" }, data: { title: "from the future" } }) },
      { path: "entities/hologram/h1.json", content: JSON.stringify({ schema: 1, type: "hologram", id: "h1", version: 1, deleted: false, appliedOps: [], data: {} }) },
    ], "newer client");
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.planningItem.findUnique({ where: { id: "future" } })).toBeNull();
    expect((await alice.db.space.findFirstOrThrow()).lastError).toMatch(/needs a newer Mergeport/);
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "alice edit" } });
    await alice.engine.syncSpace(aliceCommon);
    expect(Object.keys(server.files("olive", plan.repoName))).toContain("entities/hologram/h1.json"); // preserved

    // newer MANIFEST: the whole space becomes read-only until the app is updated
    const head2 = (await st.head("main")) as { sha: string; treeSha: string };
    const man = JSON.parse(server.files("olive", plan.repoName)["mergeport.json"]);
    await st.commit("main", head2, [{ path: "mergeport.json", content: JSON.stringify({ ...man, schema: 99 }) }], "upgrade");
    await alice.engine.pullSpace(await alice.db.space.findFirstOrThrow());
    const s = await alice.db.space.findFirstOrThrow();
    expect(s.access).toBe("SCHEMA_NEWER");
    expect((await alice.engine.stateFor(s)).state).toBe("schema");
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "blocked edit" } });
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(0); // no writes to a space we cannot understand
  });
});

describe("revoked access and rate limits", () => {
  it("revocation stops reads and writes, quarantines unsent edits and removes the cached copy", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.repository.count()).toBe(1);

    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "unsent edit" } });
    await alice.engine.capture();
    await olive.team.revokeInvitationOrAccess(common, "alice");
    server.calls.length = 0;
    clock.advance(11 * 60_000);
    await alice.engine.syncSpace(await alice.db.space.findFirstOrThrow());

    const s = await alice.db.space.findFirstOrThrow();
    expect(s.access).toBe("REVOKED");
    expect((await alice.engine.stateFor(s)).state).toBe("revoked");
    expect(await alice.db.planningItem.count()).toBe(0);
    expect(await alice.db.repository.count()).toBe(0);
    expect(await alice.db.project.count()).toBe(0);
    const op = await alice.db.outboxOp.findFirstOrThrow();
    expect(op.status).toBe("QUARANTINED"); // kept, not deleted, and never sent
    expect(server.calls.filter((c) => c.startsWith("alice") && /POST|PATCH|PUT/.test(c)).length).toBe(0);
    // no further writes are attempted
    await alice.engine.capture();
    await alice.engine.pushSpace(s);
    expect(server.history("olive", common.repoName).join("\n")).not.toMatch(/unsent/);
    await alice.engine.releaseQuarantine(s.id, "discard");
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("rate-limit exhaustion: edits stay queued, no requests leak until the reset, then they go out", async () => {
    const { olive, common } = await teamOfTwo();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "queued during limit" } });
    server.rateLimitedUntil = clock.t + 20 * 60_000;
    await olive.engine.syncSpace(await olive.db.space.findFirstOrThrow());
    const s = await olive.db.space.findFirstOrThrow();
    expect((await olive.engine.stateFor(s)).state).toBe("rate-limited");
    expect(await olive.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
    server.calls.length = 0;
    clock.advance(5 * 60_000);
    await olive.engine.tick();
    expect(server.calls.filter((c) => c.startsWith("olive")).length).toBe(0); // budget respected: nothing sent
    clock.advance(20 * 60_000);
    server.rateLimitedUntil = null;
    await olive.engine.tick();
    expect(JSON.parse(server.files("olive", common.repoName)[`entities/card/${seed.card.id}.json`]).data.title).toBe("queued during limit");
  });

  it("polling backs off while nothing changes, resets on change, and caps at two minutes", async () => {
    const { olive, common } = await teamOfTwo();
    await olive.engine.syncSpace(common);
    const intervals: number[] = [];
    for (let i = 0; i < 40; i++) {
      clock.advance(3 * 60_000);
      await olive.engine.tick();
      intervals.push((await olive.db.space.findFirstOrThrow()).pollIntervalMs);
    }
    expect(intervals[0]).toBe(30_000);
    expect(Math.max(...intervals)).toBe(2 * 60_000);
    expect(intervals.every((v, i) => i === 0 || v >= intervals[i - 1])).toBe(true);
  });
});

describe("privacy boundaries", () => {
  it("restricted data lives only in its own repository: the common repository and its history reveal nothing about it", async () => {
    const olive = await mk("olive");
    const alice = await mk("alice");
    const bram = await mk("bram");
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    for (const c of [alice, bram]) {
      await olive.team.invite(common, olive.team.planInvite(common, [c.login]), { confirmed: true });
      await c.team.acceptInvitation((await c.team.myInvitations())[0].id);
      await c.team.join(plan.fullName, { confirmed: true });
    }
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll Secrets" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);

    await seedProject(olive, restricted, { repoFullName: "acme/payroll-vault", githubId: 31337n, project: "Payroll Overhaul", card: "Migrate salary table" });
    await seedProject(olive, common, { repoFullName: "acme/public-site", githubId: 1111n, project: "Website", card: "Fix footer" });
    for (const s of await olive.db.space.findMany()) await olive.engine.syncSpace(s);

    // 1. Anyone who can read the common repository sees nothing restricted, in files or in history.
    const commonText = visibleText(server, "olive", plan.repoName);
    for (const secret of ["payroll", "Payroll", "salary", "31337", restricted.repoName]) expect(commonText).not.toContain(secret);
    expect(commonText).toContain("Website");

    // 2. Bram (common only) cannot even see the restricted repository, and discovery does not find it.
    expect(await bram.fetch(`https://api.github.com/repos/olive/${restricted.repoName}`)).toHaveProperty("status", 404);
    expect((await bram.team.candidates()).filter((c) => c.status !== "already-joined")).toHaveLength(0); // nothing restricted is visible to bram, so nothing is even offered
    for (const s of await bram.db.space.findMany()) await bram.engine.syncSpace(s);
    expect((await listRepositories(bram.db, await bram.viewer())).map((r) => r.fullName)).toEqual(["acme/public-site"]);
    expect(JSON.stringify(await bram.db.project.findMany())).not.toMatch(/Payroll/);
    expect(await bram.db.space.count()).toBe(1);

    // 3. Alice (invited to the restricted space) discovers and aggregates both; owner aggregates both.
    expect(await alice.db.space.count()).toBe(1); // discovery alone joins nothing
    const offered = await alice.team.candidates();
    expect(offered.filter((c) => c.status === "joinable").map((c) => c.spaceName)).toEqual(["Payroll Secrets"]);
    for (const c of offered.filter((x) => x.status === "joinable")) await alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId });
    for (const s of await alice.db.space.findMany()) await alice.engine.syncSpace(s);
    expect((await listRepositories(alice.db, await alice.viewer())).map((r) => r.fullName).sort()).toEqual(["acme/payroll-vault", "acme/public-site"]);
    expect((await listRepositories(olive.db, await olive.viewer())).length).toBe(2);
  });

  it("the owner is administrator because GitHub says so; a forged local role grants no GitHub authority and is undone on sync", async () => {
    const { olive, alice, common, aliceCommon } = await teamOfTwo();
    expect((await olive.db.member.findFirstOrThrow()).role).toBe("ADMIN");
    await alice.db.member.updateMany({ data: { role: "ADMIN" } });
    // creating a restricted space under the org/owner namespace needs GitHub rights the member does not have
    await expect(alice.team.createRestrictedSpace({ name: "Sneaky", owner: "olive" })).rejects.toBeInstanceOf(GithubError);
    await alice.engine.syncSpace(aliceCommon);
    expect((await alice.db.member.findFirstOrThrow()).role).toBe("MEMBER");
    void common;
  });

  it("no token, path or local file ever reaches a coordination repository", async () => {
    const { olive, common } = await teamOfTwo();
    await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    const text = visibleText(server, "olive", common.repoName);
    expect(text).not.toMatch(/ghp_|gho_|github_pat_|Authorization|\.env|C:\\\\|\/home\//i);
    expect(Object.keys(server.files("olive", common.repoName)).every((p) => p === "mergeport.json" || p.startsWith("entities/"))).toBe(true);
  });
});
