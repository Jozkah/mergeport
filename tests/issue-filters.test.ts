import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { listWorkItemAuthors, listWorkItems, type WorkItemListParams } from "@/lib/services/queries";
import { createTestPrisma } from "./pg";

/**
 * Issue list filters (authors, repository kind, the viewer's GitHub permission). Workspace one (viewer alice, admin) has:
 *   own   alice/own    public, alice's own          access push  -> Write   issue #1 by bob
 *   priv  acme/priv    private, org                 access admin -> Admin   issue #2 by carol
 *   fork  acme/fork    public fork, org             access row for ANOTHER installation -> Read only   issue #3 by Bob
 *   local alice/local  private, own, no installation no access row -> Read only                      issue #4 by dave
 * plus a pull request by erin in `own`. Workspace two (viewer zed) has acme/secret with an issue by mallory.
 */

let db: Db;
let alice: Viewer;
let member: Viewer;
let zed: Viewer;
const I: Record<string, string> = {};
let ownRepoGithubId: bigint;

const at = new Date("2026-10-01T00:00:00Z");

async function install(ws: string, installationId: bigint) {
  await db.githubInstallation.create({ data: { installationId, accountGithubId: 9000n, accountLogin: "acme", accountType: "ORGANIZATION" } });
  await db.workspaceInstallation.create({ data: { workspaceId: ws, installationId, verifiedAt: at, verifiedGithubUserId: 11n, proofMethod: "test" } });
}

beforeAll(async () => {
  db = createTestPrisma("issue-filters");
  const ws1 = await db.workspace.create({ data: { name: "one" } });
  const ws2 = await db.workspace.create({ data: { name: "two" } });
  const ua = await db.user.create({ data: { githubId: 11n, githubLogin: "alice", login: "alice" } });
  const um = await db.user.create({ data: { githubId: 12n, githubLogin: "mem", login: "mem" } });
  const uz = await db.user.create({ data: { githubId: 22n, githubLogin: "zed", login: "zed" } });
  const ma = await db.member.create({ data: { workspaceId: ws1.id, userId: ua.id, role: "ADMIN" } });
  const mm = await db.member.create({ data: { workspaceId: ws1.id, userId: um.id, role: "MEMBER" } });
  await db.member.create({ data: { workspaceId: ws2.id, userId: uz.id, role: "ADMIN" } });
  await install(ws1.id, 777n);
  await install(ws2.id, 888n);
  const oAlice = await db.githubOwner.create({ data: { githubId: 11n, login: "alice", type: "USER" } });
  const oAcme = await db.githubOwner.create({ data: { githubId: 9000n, login: "acme", type: "ORGANIZATION" } });

  const repo = (workspaceId: string, githubId: bigint, ownerId: string, fullName: string, extra: { visibility: "PUBLIC" | "PRIVATE"; isFork?: boolean; installationId?: bigint | null }) =>
    db.repository.create({ data: { workspaceId, githubId, ownerId, name: fullName.split("/")[1], fullName, htmlUrl: `https://github.com/${fullName}`, defaultBranch: "main", visibility: extra.visibility, isFork: extra.isFork ?? false, installationId: extra.installationId ?? null } });
  const own = await repo(ws1.id, 100n, oAlice.id, "alice/own", { visibility: "PUBLIC", installationId: 777n });
  const priv = await repo(ws1.id, 200n, oAcme.id, "acme/priv", { visibility: "PRIVATE", installationId: 777n });
  const fork = await repo(ws1.id, 300n, oAcme.id, "acme/fork", { visibility: "PUBLIC", isFork: true, installationId: 777n });
  const local = await repo(ws1.id, 400n, oAlice.id, "alice/local", { visibility: "PRIVATE" });
  const secret = await repo(ws2.id, 300n, oAcme.id, "acme/secret", { visibility: "PRIVATE", installationId: 888n });
  ownRepoGithubId = own.githubId;

  let n = 0;
  const item = async (key: string, repositoryId: string, authorLogin: string, type: "ISSUE" | "PULL_REQUEST" = "ISSUE") => {
    n++;
    I[key] = (await db.workItem.create({ data: { repositoryId, githubId: BigInt(5000 + n), number: n, type, title: key, authorLogin, htmlUrl: `https://github.com/x/${n}`, createdAtGh: at, updatedAtGh: at } })).id;
  };
  await item("i1", own.id, "bob");
  await item("i2", priv.id, "carol");
  await item("i3", fork.id, "Bob");
  await item("i4", local.id, "dave");
  await item("pr", own.id, "erin", "PULL_REQUEST");
  await item("x", secret.id, "mallory");

  const now = new Date();
  const access = (userId: string, repositoryGithubId: bigint, installationId: bigint, permission: string) => db.githubRepoAccess.create({ data: { userId, repositoryGithubId, installationId, permission, checkedAt: now } });
  await access(ua.id, 100n, 777n, "push");
  await access(ua.id, 200n, 777n, "admin");
  // Admin on githubId 300 through workspace two's installation: says nothing about acme/fork (installation 777) in workspace one.
  await access(ua.id, 300n, 888n, "admin");
  // The member's push on githubId 200 came through workspace two's installation, so it neither reveals acme/priv nor makes it Write.
  await access(um.id, 200n, 888n, "push");
  await db.repositoryGrant.create({ data: { memberId: mm.id, repositoryId: own.id, grantedById: ma.id, canManageWork: true, canReview: true } });

  alice = (await loadViewer(db, ua.id, ws1.id))!;
  member = (await loadViewer(db, um.id, ws1.id))!;
  zed = (await loadViewer(db, uz.id, ws2.id))!;
});
afterAll(() => db.$disconnect());

const list = async (v: Viewer, p: Partial<WorkItemListParams>) => (await listWorkItems(db, v, { type: "ISSUE", state: "ALL", pageSize: 100, ...p })).rows.map((r) => r.title).sort();

describe("issue filters", () => {
  it("authors: exact, case-insensitive, OR within the group", async () => {
    expect(await list(alice, {})).toEqual(["i1", "i2", "i3", "i4"]);
    expect(await list(alice, { authors: ["bob"] })).toEqual(["i1", "i3"]);
    expect(await list(alice, { authors: ["bo"] })).toEqual([]); // not a substring match
    expect(await list(alice, { authors: ["bob", "carol"] })).toEqual(["i1", "i2", "i3"]);
  });

  it("repository kind: private, forks, shared (owned by another account), OR within the group", async () => {
    expect(await list(alice, { repoKinds: ["private"] })).toEqual(["i2", "i4"]);
    expect(await list(alice, { repoKinds: ["fork"] })).toEqual(["i3"]);
    expect(await list(alice, { repoKinds: ["shared"] })).toEqual(["i2", "i3"]);
    expect(await list(alice, { repoKinds: ["private", "fork"] })).toEqual(["i2", "i3", "i4"]);
  });

  it("the viewer's permission: no fresh row (or one from another installation) counts as Read only", async () => {
    expect(await list(alice, { permissions: ["read"] })).toEqual(["i3", "i4"]);
    expect(await list(alice, { permissions: ["write"] })).toEqual(["i1"]);
    expect(await list(alice, { permissions: ["admin"] })).toEqual(["i2"]);
    expect(await list(alice, { permissions: ["write", "admin"] })).toEqual(["i1", "i2"]);
    expect(await list(alice, { permissions: ["read", "write", "admin"] })).toEqual(["i1", "i2", "i3", "i4"]);
  });

  it("groups combine with AND", async () => {
    expect(await list(alice, { authors: ["bob"], repoKinds: ["fork"] })).toEqual(["i3"]);
    expect(await list(alice, { authors: ["bob"], permissions: ["write"] })).toEqual(["i1"]);
    expect(await list(alice, { repoKinds: ["private"], permissions: ["admin"] })).toEqual(["i2"]);
    expect(await list(alice, { repoKinds: ["private"], permissions: ["write"] })).toEqual([]);
    expect(await list(alice, { authors: ["dave", "carol"], repoKinds: ["private", "fork"], permissions: ["read"] })).toEqual(["i4"]);
  });

  it("author options come only from the viewer's visible items of that type", async () => {
    expect((await listWorkItemAuthors(db, alice, "ISSUE")).map((a) => a.login).sort()).toEqual(["Bob", "bob", "carol", "dave"]);
    expect((await listWorkItemAuthors(db, alice, "PULL_REQUEST")).map((a) => a.login)).toEqual(["erin"]);
    expect((await listWorkItemAuthors(db, member, "ISSUE")).map((a) => a.login)).toEqual(["bob"]);
    expect((await listWorkItemAuthors(db, zed, "ISSUE")).map((a) => a.login)).toEqual(["mallory"]);
  });

  it("never widens the tenant or grant scope", async () => {
    expect(await list(alice, { authors: ["mallory"] })).toEqual([]);
    expect(await list(zed, { authors: ["bob", "carol"] })).toEqual([]);
    expect(await list(zed, { permissions: ["read", "write", "admin"] })).toEqual(["x"]);
    // Only the granted repository is searched; the push row from another installation counts for nothing.
    expect(await list(member, { permissions: ["write"] })).toEqual([]);
    expect(await list(member, { permissions: ["read", "write", "admin"] })).toEqual(["i1"]);
    expect(await list(member, { authors: ["carol"] })).toEqual([]);
  });

  it("a stale access row grants no Write: the repository falls back to Read only", async () => {
    await db.githubRepoAccess.updateMany({ where: { userId: alice.userId, repositoryGithubId: ownRepoGithubId }, data: { checkedAt: new Date(Date.now() - 24 * 3600_000) } });
    expect(await list(alice, { permissions: ["write"] })).toEqual([]);
    expect(await list(alice, { permissions: ["read"] })).toEqual(["i1", "i3", "i4"]);
  });
});
