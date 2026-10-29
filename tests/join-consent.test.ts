import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { GitHubRest } from "@/lib/github/rest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { MANIFEST_SCHEMA } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { clock, makeClient, type Client } from "./harness";

let server: FakeGitHubServer;
let clients: Client[] = [];
const mk = async (login: string) => {
  const c = await makeClient(server, login);
  clients.push(c);
  return c;
};
beforeEach(() => {
  server = new FakeGitHubServer(() => clock.t);
  for (const u of ["olive", "alice", "mallory"]) server.addUser(u);
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function team() {
  const olive = await mk("olive");
  const alice = await mk("alice");
  const plan = await olive.team.planTeam({ name: "Atlas Crew" });
  const common = await olive.team.createTeam(plan, { confirmed: true });
  await olive.team.invite(common, olive.team.planInvite(common, ["alice"]), { confirmed: true });
  await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
  await alice.team.join(plan.fullName, { confirmed: true });
  const teamRow = await olive.db.teamConfig.findUniqueOrThrow({ where: { id: "team" } });
  return { olive, alice, plan, common, teamId: teamRow.teamRemoteId! };
}

/** Creates a private repository for `owner` containing a hand-made manifest, and makes `invitee` able to read it. */
async function plant(owner: Client, name: string, manifest: Record<string, unknown>, invitee?: Client, o: { isPublic?: boolean } = {}) {
  await owner.fetch("https://api.github.com/user/repos", { method: "POST", body: JSON.stringify({ name, private: !o.isPublic }) });
  await new CoordinationStore(new GitHubRest(owner.fetch), owner.login, name).initialCommit("main", "mergeport.json", JSON.stringify(manifest), "plant");
  if (invitee) {
    await owner.fetch(`https://api.github.com/repos/${owner.login}/${name}/collaborators/${invitee.login}`, { method: "PUT", body: JSON.stringify({ permission: "push" }) });
    await invitee.team.acceptInvitation((await invitee.team.myInvitations()).find((i) => i.fullName.endsWith(`/${name}`))!.id);
  }
  return `${owner.login}/${name}`;
}
const manifestFor = (teamId: string, by: { id: string; login: string }, o: Record<string, unknown> = {}) => ({ schema: MANIFEST_SCHEMA, kind: "mergeport-space", spaceId: `space-${Math.random().toString(36).slice(2)}`, teamId, teamName: "Atlas Crew", spaceKind: "RESTRICTED", name: "Payroll", createdAt: "2026-10-29T00:00:00Z", createdBy: by, ...o });

describe("discovery offers; only an explicit, confirmed Join imports", () => {
  it("listing candidates joins nothing and writes no shared state", async () => {
    const { olive, alice } = await team();
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const spacesBefore = await alice.db.space.count();
    const entitiesBefore = await alice.db.syncEntity.count();
    const list = await alice.team.candidates();
    const c = list.find((x) => x.name === restricted.repoName)!;
    expect(c).toMatchObject({ status: "joinable", visibility: "private", spaceKind: "RESTRICTED", teamName: "Atlas Crew", expectedAccess: "write", owner: "olive" });
    expect(c.downloads).toMatch(/downloads/i);
    expect(c.publishes).toMatch(/publishes nothing/i);
    expect(await alice.db.space.count()).toBe(spacesBefore);
    expect(await alice.db.syncEntity.count()).toBe(entitiesBefore);
  });

  it("joining needs confirmation, and the repository id the person saw", async () => {
    const { olive, alice } = await team();
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const c = (await alice.team.candidates()).find((x) => x.name === restricted.repoName)!;
    await expect(alice.team.join(c.fullName, { confirmed: false })).rejects.toBeInstanceOf(ValidationError);
    expect(await alice.db.space.count({ where: { repoName: restricted.repoName } })).toBe(0);
    await expect(alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId + 1 })).rejects.toThrow(/changed since it was listed/);
    expect(await alice.db.space.count({ where: { repoName: restricted.repoName } })).toBe(0);
    const s = await alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId });
    expect(s.repoGithubId).toBe(BigInt(c.repoId));
  });

  it("joining twice is idempotent: one space, not two", async () => {
    const { olive, alice } = await team();
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const a = await alice.team.join(restricted.repoOwner + "/" + restricted.repoName, { confirmed: true });
    const b = await alice.team.join(restricted.repoOwner + "/" + restricted.repoName, { confirmed: true });
    expect(b.id).toBe(a.id);
    expect(await alice.db.space.count({ where: { repoName: restricted.repoName } })).toBe(1);
    expect((await alice.team.candidates()).find((x) => x.name === restricted.repoName)?.status).toBe("already-joined");
  });
});

describe("a name prefix or an editable manifest is not trust", () => {
  it("a look-alike repository under another owner is shown as not trusted and cannot be joined", async () => {
    const { alice, teamId } = await team();
    const mallory = await mk("mallory");
    const full = await plant(mallory, "mergeport-atlas-crew-payroll", manifestFor(teamId, { id: String(server.users.get("mallory")!.id), login: "mallory" }), alice);
    const c = (await alice.team.candidates()).find((x) => x.fullName === full)!;
    expect(c.status).toBe("untrusted-owner");
    await expect(alice.team.join(full, { confirmed: true })).rejects.toBeInstanceOf(ValidationError);
    expect(await alice.db.space.count({ where: { repoName: "mergeport-atlas-crew-payroll" } })).toBe(0);
  });

  it("a copied manifest naming the real owner as creator, inside someone else's personal account, is refused", async () => {
    const { olive, alice, teamId } = await team();
    const mallory = await mk("mallory");
    const oliveId = String(server.users.get("olive")!.id);
    const full = await plant(mallory, "mergeport-atlas-crew-forged", manifestFor(teamId, { id: oliveId, login: "olive" }), alice);
    // Not under the team's owner, and the claimed creator is not the owner of the account it lives in.
    expect((await alice.team.candidates()).find((x) => x.fullName === full)?.status).toBe("untrusted-owner");
    await expect(alice.team.join(full, { confirmed: true })).rejects.toBeInstanceOf(ValidationError);
    void olive;
  });

  it("under the team owner, a manifest whose creator is not the account owner is refused", async () => {
    const { olive, alice, teamId } = await team();
    const full = await plant(olive, "mergeport-atlas-crew-oddity", manifestFor(teamId, { id: "424242", login: "somebody-else" }), alice);
    const c = (await alice.team.candidates()).find((x) => x.fullName === full)!;
    expect(c.status).toBe("untrusted-owner");
    expect(c.reason).toMatch(/copied manifest/i);
  });

  it("a space of a different team is not offered, even under the same owner and prefix", async () => {
    const { olive, alice } = await team();
    const full = await plant(olive, "mergeport-atlas-crew-other", manifestFor("another-team-id", { id: String(server.users.get("olive")!.id), login: "olive" }), alice);
    expect((await alice.team.candidates()).find((x) => x.fullName === full)?.status).toBe("other-team");
    await expect(alice.team.join(full, { confirmed: true })).rejects.toThrow(/different team/);
  });

  it("a newer schema is shown and cannot be joined", async () => {
    const { olive, alice, teamId } = await team();
    const full = await plant(olive, "mergeport-atlas-crew-future", manifestFor(teamId, { id: String(server.users.get("olive")!.id), login: "olive" }, { schema: 99 }), alice);
    expect((await alice.team.candidates()).find((x) => x.fullName === full)?.status).toBe("unsupported-schema");
    await expect(alice.team.join(full, { confirmed: true })).rejects.toThrow(/newer Mergeport/);
  });

  it("a public repository, a repository with no manifest, and an unreadable one are never joinable", async () => {
    const { olive, alice } = await team();
    await olive.fetch("https://api.github.com/user/repos", { method: "POST", body: JSON.stringify({ name: "mergeport-atlas-crew-plain", private: true }) });
    await expect(alice.team.join("olive/mergeport-atlas-crew-plain", { confirmed: true })).rejects.toThrow(); // alice cannot read it: no access
    const pub = await mk("mallory");
    await plant(pub, "mergeport-atlas-crew-pub", manifestFor("x", { id: "1", login: "mallory" }), undefined, { isPublic: true });
    await expect(alice.team.join("mallory/mergeport-atlas-crew-pub", { confirmed: true })).rejects.toThrow(/public/);
  });

  it("a first join into a team must be the COMMON space; a restricted one needs the team first", async () => {
    const olive = await mk("olive");
    const alice = await mk("alice");
    const plan = await olive.team.planTeam({ name: "Atlas Crew" });
    const common = await olive.team.createTeam(plan, { confirmed: true });
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    for (const s of [common, restricted]) await olive.team.invite(s, olive.team.planInvite(s, ["alice"]), { confirmed: true });
    for (const i of await alice.team.myInvitations()) await alice.team.acceptInvitation(i.id);
    const c = await alice.team.inspect(`olive/${restricted.repoName}`);
    expect(c.status).toBe("needs-team");
    await expect(alice.team.join(`olive/${restricted.repoName}`, { confirmed: true })).rejects.toThrow(/common space first/);
    await alice.team.join(plan.fullName, { confirmed: true });
  });
});

describe("access changes and replaced repositories", () => {
  it("access revoked between listing and joining: nothing is joined", async () => {
    const { olive, alice } = await team();
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const c = (await alice.team.candidates()).find((x) => x.name === restricted.repoName)!;
    await olive.team.revokeInvitationOrAccess(restricted, "alice");
    await expect(alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await alice.db.space.count({ where: { repoName: restricted.repoName } })).toBe(0);
  });

  it("a repository deleted and recreated under the same name is a different space, never auto-trusted", async () => {
    const { olive, alice } = await team();
    const restricted = await olive.team.createRestrictedSpace({ name: "Payroll" });
    await olive.team.invite(restricted, olive.team.planInvite(restricted, ["alice"]), { confirmed: true });
    await alice.team.acceptInvitation((await alice.team.myInvitations())[0].id);
    const c = (await alice.team.candidates()).find((x) => x.name === restricted.repoName)!;
    const joined = await alice.team.join(c.fullName, { confirmed: true, expectedRepoId: c.repoId });
    // the owner deletes it and someone recreates a repository with the same name and a fresh manifest
    server.repos.delete(`olive/${restricted.repoName}`);
    const teamId = joined.teamRemoteId;
    const full = await plant(olive, restricted.repoName, manifestFor(teamId, { id: String(server.users.get("olive")!.id), login: "olive" }, { name: "Payroll", spaceId: "a-new-space-id" }), alice);
    const again = await alice.team.inspect(full);
    expect(again.status).toBe("identity-changed");
    await expect(alice.team.join(full, { confirmed: true })).rejects.toThrow(/different repository/);
    expect(await alice.db.space.count({ where: { repoName: restricted.repoName } })).toBe(1);
  });
});
