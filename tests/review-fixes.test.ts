import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { GitHubRest } from "@/lib/github/rest";
import { ValidationError } from "@/lib/errors";
import { assertSameAudience, createCard } from "@/lib/services/planning";
import { shareRepositoryToSpace, unshareRepository } from "@/lib/services/repositories";
import { CoordinationStore } from "@/lib/sync/store";
import { clock, makeClient, seedProject, type Client } from "./harness";

let server: FakeGitHubServer;
let clients: Client[] = [];
const mk = async (login: string) => {
  const c = await makeClient(server, login);
  clients.push(c);
  return c;
};
beforeEach(() => {
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice"]) server.addUser(u);
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

/** Owner + alice, both in the common space, and alice also in a restricted space. */
async function twoSpaces() {
  const olive = await mk("olive");
  const alice = await mk("alice");
  const plan = await olive.team.planTeam({ name: "Atlas Crew" });
  const common = await olive.team.createTeam(plan, { confirmed: true });
  await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
  await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
  const aliceCommon = await alice.team.join(plan.fullName, { confirmed: true });
  const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
  await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
  await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
  for (const c of (await alice.team.candidates()).filter((x) => x.status === "joinable")) await alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId });
  const aliceRestricted = await alice.db.space.findFirstOrThrow({ where: { repoName: restricted.repoName } });
  return { olive, alice, plan, common, aliceCommon, restricted, aliceRestricted };
}

const store = (owner: string, repo: string, as = "olive") => new CoordinationStore(new GitHubRest(server.fetchFor(as)), owner, repo);
const commitFiles = async (owner: string, repo: string, files: { path: string; content: string }[], as = "olive") => {
  const st = store(owner, repo, as);
  const head = (await st.head("main")) as { sha: string; treeSha: string };
  await st.commit("main", head, files, "test");
};
const entityFile = (type: string, id: string, o: { version?: number; deleted?: boolean; schema?: number; data?: unknown } = {}) =>
  JSON.stringify({ schema: o.schema ?? 1, type, id, version: o.version ?? 5, deleted: o.deleted ?? false, appliedOps: [], updatedAt: "2026-10-29T00:00:00Z", updatedBy: { id: "1", login: "mallory" }, data: o.data ?? {} });

describe("an entity belongs to the space it was placed in", () => {
  it("a tombstone from another space cannot delete a project that lives in a different space", async () => {
    const { olive, alice, common, aliceCommon, restricted, aliceRestricted } = await twoSpaces();
    const seed = await seedProject(olive, restricted, { repoFullName: "acme/payroll-vault", githubId: 31337n, project: "Payroll", card: "Migrate salary table" });
    await olive.engine.syncSpace(restricted);
    await alice.engine.syncSpace(aliceRestricted);
    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(1);

    await commitFiles(common.repoOwner, common.repoName, [{ path: `entities/project/${seed.project.id}.json`, content: entityFile("project", seed.project.id, { deleted: true }) }]);
    await alice.engine.syncSpace(aliceCommon);

    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(1);
    expect(await alice.db.planningItem.count({ where: { id: seed.card.id } })).toBe(1);
    expect(await alice.db.outboxOp.count({ where: { kind: "DELETE" } })).toBe(0); // nothing queued to delete the restricted copy
  });

  it("a repository file from another space cannot take over or rename a repository placed elsewhere", async () => {
    const { olive, alice, common, aliceCommon, restricted, aliceRestricted } = await twoSpaces();
    await seedProject(olive, restricted, { repoFullName: "acme/payroll-vault", githubId: 31337n });
    await olive.engine.syncSpace(restricted);
    await alice.engine.syncSpace(aliceRestricted);
    const before = await alice.db.repository.findFirstOrThrow({ where: { githubId: 31337n } });
    expect(before.spaceId).toBe(aliceRestricted.id);

    const evil = { githubId: "31337", fullName: "evil/renamed", name: "renamed", htmlUrl: "https://example.test/x", visibility: "PRIVATE", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: "1", login: "evil", type: "USER" } };
    await commitFiles(common.repoOwner, common.repoName, [{ path: "entities/repo/repo-31337.json", content: entityFile("repo", "repo-31337", { data: evil }) }]);
    await alice.engine.syncSpace(aliceCommon);

    const after = await alice.db.repository.findFirstOrThrow({ where: { githubId: 31337n } });
    expect(after).toMatchObject({ spaceId: aliceRestricted.id, fullName: "acme/payroll-vault" });
  });
});

describe("a bad file cannot stall sync", () => {
  it("a malformed entity is skipped and reported; the rest of the space still syncs and polling moves on", async () => {
    const { olive, alice, common, aliceCommon } = await twoSpaces();
    const seed = await seedProject(olive, common);
    await commitFiles(common.repoOwner, common.repoName, [{ path: "entities/repo/repo-5.json", content: entityFile("repo", "repo-5", { data: { nonsense: true } }) }]);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.project.count({ where: { id: seed.project.id } })).toBe(1);
    const s = await alice.db.space.findFirstOrThrow({ where: { id: aliceCommon.id } });
    expect(s.lastError).toMatch(/Skipped/);
    expect(s.nextPollAt && s.nextPollAt.getTime()).toBeGreaterThan(clock.t);
  });

  it("a repository that is not the space that was joined is never read", async () => {
    const { alice, aliceCommon, common } = await twoSpaces();
    await alice.engine.syncSpace(aliceCommon);
    const man = JSON.parse(server.files(common.repoOwner, common.repoName)["mergeport.json"]);
    await commitFiles(common.repoOwner, common.repoName, [{ path: "mergeport.json", content: JSON.stringify({ ...man, spaceId: "someone-elses-space" }) }]);
    const r = await alice.engine.pullSpace(await alice.db.space.findFirstOrThrow({ where: { id: aliceCommon.id } }));
    expect(r.changed).toBe(false);
    expect((await alice.db.space.findFirstOrThrow({ where: { id: aliceCommon.id } })).lastError).toMatch(/not the space you joined/);
  });
});

describe("conflicts stay open until a person decides", () => {
  it("a later remote change does not settle the conflict as 'mine' or unpause the held edit", async () => {
    const { olive, alice, common, aliceCommon } = await twoSpaces();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Olive's title" } });
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "Alice's title" } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    expect(await alice.db.syncConflict.count({ where: { status: "OPEN" } })).toBe(1);

    // Olive changes something unrelated; the remote moves again.
    await olive.db.planningItem.update({ where: { id: seed.card.id }, data: { priority: 3 } });
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);

    expect(await alice.db.syncConflict.count({ where: { status: "OPEN" } })).toBe(1);
    expect((await alice.db.outboxOp.findFirstOrThrow({ where: { entityId: seed.card.id } })).status).toBe("CONFLICT");
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect((c.remote as { priority: number }).priority).toBe(3); // decided against the newest remote
    await alice.engine.resolveConflict(c.id, "theirs");
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("Olive's title");
  });
});

describe("newer files and quarantine", () => {
  it("a local edit to an entity written by a newer Mergeport is never pushed over it", async () => {
    const { olive, alice, common, aliceCommon } = await twoSpaces();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await commitFiles(common.repoOwner, common.repoName, [{ path: `entities/card/${seed.card.id}.json`, content: entityFile("card", seed.card.id, { schema: 2, version: 9, data: { title: "newer", futureField: true } }) }]);
    await alice.engine.syncSpace(aliceCommon);
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "old client edit" } });
    await alice.engine.syncSpace(aliceCommon);
    const file = JSON.parse(server.files(common.repoOwner, common.repoName)[`entities/card/${seed.card.id}.json`]);
    expect(file.schema).toBe(2);
    expect(file.data.futureField).toBe(true);
  });

  it("a quarantined edit is not re-captured; discarding it puts the local copy back", async () => {
    const { olive, alice, common, aliceCommon } = await twoSpaces();
    const seed = await seedProject(olive, common);
    await olive.engine.syncSpace(common);
    await alice.engine.syncSpace(aliceCommon);
    await alice.db.planningItem.update({ where: { id: seed.card.id }, data: { title: "unsent" } });
    await alice.engine.capture();
    await alice.db.outboxOp.updateMany({ data: { status: "QUARANTINED" } });
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count()).toBe(1); // no duplicate
    await alice.engine.releaseQuarantine(aliceCommon.id, "discard");
    expect((await alice.db.planningItem.findUniqueOrThrow({ where: { id: seed.card.id } })).title).toBe("Rotate the signing keys");
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count()).toBe(0);
  });
});

describe("a project and its repositories share one audience", () => {
  it("rejects linking, carding, sharing and unsharing that would publish a narrower space's data to a wider one", async () => {
    const { olive, common, restricted } = await twoSpaces();
    const v = await olive.viewer();
    const wide = await seedProject(olive, common, { repoFullName: "acme/public-site", githubId: 1111n, project: "Website" });
    const secret = await seedProject(olive, restricted, { repoFullName: "acme/payroll-vault", githubId: 31337n, project: "Payroll" });
    // a restricted repository cannot be linked to a project shared through the common space
    await expect(assertSameAudience(olive.db, common.id, [secret.repo.id])).rejects.toBeInstanceOf(ValidationError);
    await expect(assertSameAudience(olive.db, common.id, [wide.repo.id])).resolves.toBeUndefined();
    await expect(assertSameAudience(olive.db, null, [secret.repo.id])).resolves.toBeUndefined(); // a local project can link anything
    // a card from a restricted repository's issue cannot be created in the common project
    await olive.db.projectRepository.create({ data: { projectId: wide.project.id, repositoryId: secret.repo.id } });
    const item = await olive.db.workItem.create({ data: { repositoryId: secret.repo.id, githubId: 9n, number: 1, type: "ISSUE", title: "Salary of Dana", htmlUrl: "https://x/1", createdAtGh: new Date(), updatedAtGh: new Date() } });
    await expect(createCard(olive.db, v, { projectId: wide.project.id, workItemId: item.id })).rejects.toBeInstanceOf(ValidationError);
    // moving a repository's audience away from a project that links it is refused
    await olive.db.projectRepository.deleteMany({ where: { projectId: wide.project.id, repositoryId: secret.repo.id } });
    await expect(unshareRepository(olive.db, v, wide.repo.id)).rejects.toBeInstanceOf(ValidationError);
    await olive.db.repository.update({ where: { id: wide.repo.id }, data: { spaceId: null } });
    await olive.db.projectRepository.create({ data: { projectId: secret.project.id, repositoryId: wide.repo.id } });
    await expect(shareRepositoryToSpace(olive.db, v, wide.repo.id, common.id)).rejects.toBeInstanceOf(ValidationError); // a project in the restricted space links it
  });
});
