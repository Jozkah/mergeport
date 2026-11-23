import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import type { RemoteWorkItem } from "@/lib/github/port";
import { OctokitPort } from "@/lib/github/octokit";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { syncRepository } from "@/lib/sync/repository";
import { truncateAll } from "@/lib/demo/seed";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { attention } from "@/lib/services/queries";
import { inbox } from "@/lib/services/inbox";
import { buildDigest } from "@/lib/services/digest";
import { involvesMe } from "@/lib/services/ai-review";
import { testDb } from "./helpers";

/**
 * Review queues match GitHub people by numeric id where both sides have one. The viewer is "old-name" (GitHub id 5); GitHub's data
 * is written the way a sync writes it (ids included), and a person who renamed, or who took over a released login, must land in
 * the right queue. Data without ids (older rows, local items) still matches on login.
 */
const db = testDb();
const T = (d: number) => new Date(Date.UTC(2026, 9, d));
const NOW = new Date(Date.UTC(2026, 9, 11, 9));
const ME = 5n;

const meta = (id: bigint, owner: string, name: string): RepoMeta => ({
  githubId: id, fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: id + 1000n, login: owner, type: "ORGANIZATION" },
});
const pr = (number: number, o: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({
  githubId: BigInt(500 + number), number, type: "PULL_REQUEST", title: `PR ${number}`, body: null, state: "OPEN", draft: false, authorLogin: "someone", authorGithubId: 3n, authorAvatar: null,
  labels: [], assignees: [], milestoneNumber: null, milestoneTitle: null, htmlUrl: `https://x/${number}`, createdAt: T(1), updatedAt: T(2), closedAt: null, mergedAt: null,
  headSha: "head1", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", ...o,
});

let fake: FakeGithub;
let repoId: string;
let viewer: Viewer;

const sync = (full = false) => syncRepository(db, fake, repoId, { now: T(10), full });
const queue = async () => (await attention(db, viewer, { now: NOW })).needsMyReview.map((d) => d.item.number).sort();
const row = (n: number) => db.workItem.findFirstOrThrow({ where: { repositoryId: repoId, number: n }, include: { comments: true, reviewRequests: true, repository: { include: { owner: true } } } });

beforeEach(async () => {
  await truncateAll(db);
  fake = new FakeGithub();
  const ws = await db.workspace.create({ data: { name: "ws" } });
  const m = meta(1n, "acme", "tool");
  fake.repos.set("acme/tool", m);
  repoId = (await upsertRepository(db, ws.id, m)).id;
  fake.branches.set("acme/tool", [{ name: "main", sha: "m1", isDefault: true }]);
  // A legacy local user: githubId from `gh`, GitHub login stored as the login. (Hosted users reach the same code through their link.)
  const user = await db.user.create({ data: { githubId: ME, login: "old-name", githubLogin: "old-name" } });
  await db.member.create({ data: { workspaceId: ws.id, userId: user.id, role: "OWNER" } });
  viewer = (await loadViewer(db, user.id, ws.id))!;
});

describe("sync records numeric GitHub ids", () => {
  it("stores requested-reviewer, assignee, author and review ids from the payloads", async () => {
    fake.items.set("acme/tool", [pr(1, { assignees: ["a1", "a2"], assigneeGithubIds: [11n, 12n], authorLogin: "auth", authorGithubId: 20n })]);
    fake.requested.set("acme/tool#1", { users: ["r1"], userGithubIds: [31n], teams: ["org/team"] });
    fake.reviews.set("acme/tool#1", [{ githubId: 90n, login: "rev", userGithubId: 41n, state: "COMMENTED", body: null, commitSha: "head1", submittedAt: T(3) }]);
    fake.comments.set("acme/tool#1", [{ githubId: 70n, login: "talker", userGithubId: 51n, body: "hi", createdAt: T(2), updatedAt: T(2) }]);
    await sync();
    const it1 = await row(1);
    expect(it1.assigneeIds).toBe("|11|12|");
    expect(it1.authorGithubId).toBe(20n);
    expect(it1.reviewRequests.find((r) => r.kind === "USER")?.reviewerGithubId).toBe(31n);
    expect(it1.reviewRequests.find((r) => r.kind === "TEAM")?.reviewerGithubId).toBeNull();
    expect(it1.comments.find((c) => c.kind === "REVIEW")?.authorGithubId).toBe(41n);
    expect(it1.comments.find((c) => c.kind === "ISSUE_COMMENT")?.authorGithubId).toBe(51n);
  });

  it("leaves assignee ids empty when GitHub gave none for some assignee, so those people still match by login", async () => {
    fake.items.set("acme/tool", [pr(1, { assignees: ["a1", "a2"], assigneeGithubIds: [11n, null] }), pr(2, { assignees: ["a1"] })]);
    await sync();
    expect((await row(1)).assigneeIds).toBe("");
    expect((await row(2)).assigneeIds).toBe("");
  });

  it("the REST mapping reads ids from GitHub's payload shapes and survives odd values", () => {
    const w = OctokitPort.toWorkItem({ id: 1, number: 1, title: "t", html_url: "u", state: "open", created_at: T(1).toISOString(), updated_at: T(1).toISOString(), user: { login: "u", id: 20 }, assignees: [{ login: "a", id: 11 }, { login: "b", id: "x" }] });
    expect(w.authorGithubId).toBe(20n);
    expect(w.assigneeGithubIds).toEqual([11n, null]);
    expect(OctokitPort.toComment({ id: 2, user: { login: "c", id: 7 }, body: "b", created_at: T(1).toISOString(), updated_at: T(1).toISOString() }).userGithubId).toBe(7n);
  });

  it("a renamed reviewer keeps their open request; a login taken over by another person does not inherit it", async () => {
    fake.items.set("acme/tool", [pr(1)]);
    fake.requested.set("acme/tool#1", { users: ["old-name"], userGithubIds: [ME], teams: [] });
    await sync();
    const first = (await row(1)).reviewRequests.filter((r) => !r.removedAt);
    expect(first).toHaveLength(1);

    // Renamed on GitHub: same id, new login. The same request row follows the rename; nothing new is opened.
    fake.items.set("acme/tool", [pr(1, { updatedAt: T(4) })]);
    fake.requested.set("acme/tool#1", { users: ["new-name"], userGithubIds: [ME], teams: [] });
    await sync(true);
    const renamed = await db.reviewRequest.findMany({ where: { workItemId: first[0].workItemId } });
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ id: first[0].id, reviewerRef: "new-name", reviewerGithubId: ME, removedAt: null });
    expect(await queue()).toEqual([1]);

    // Somebody else takes "new-name" and is asked instead: my request is closed, theirs is new.
    fake.items.set("acme/tool", [pr(1, { updatedAt: T(6) })]);
    fake.requested.set("acme/tool#1", { users: ["new-name"], userGithubIds: [99n], teams: [] });
    await sync(true);
    const all = await db.reviewRequest.findMany({ where: { workItemId: first[0].workItemId }, orderBy: { requestedAt: "asc" } });
    expect(all.filter((r) => !r.removedAt).map((r) => r.reviewerGithubId)).toEqual([99n]);
    expect(all.find((r) => r.id === first[0].id)?.removedAt).not.toBeNull();
    expect(await queue()).toEqual([]);
  });
});

describe("queues, inbox, digest and AI context match by id", () => {
  beforeEach(async () => {
    fake.items.set("acme/tool", [
      // 1: asked, assigned and renamed (id 5 under a new login)
      pr(1, { assignees: ["new-name"], assigneeGithubIds: [ME] }),
      // 2: the login "old-name" now belongs to someone else (id 9)
      pr(2, { assignees: ["old-name"], assigneeGithubIds: [9n] }),
      // 3: written before ids existed: login fallback
      pr(3, { assignees: ["old-name"] }),
    ]);
    fake.requested.set("acme/tool#1", { users: ["new-name"], userGithubIds: [ME], teams: [] });
    fake.requested.set("acme/tool#2", { users: ["old-name"], userGithubIds: [9n], teams: [] });
    fake.requested.set("acme/tool#3", { users: ["old-name"], teams: [] });
    await sync();
  });

  it("needs-my-review follows the id through a rename, ignores a re-used login, and still matches id-less rows by login", async () => {
    expect(await queue()).toEqual([1, 3]);
  });

  it("the inbox lists the same pull requests and versions a renamed request by id", async () => {
    const r = await inbox(db, viewer, { now: NOW });
    expect(r.entries.map((e) => e.item.number).sort()).toEqual([1, 3]);
  });

  it("involvesMe (AI review context) uses ids", async () => {
    const q = await attention(db, viewer, { now: NOW });
    const all = [...q.needsMyReview, ...q.needsTeamReview];
    const by = (n: number) => all.find((d) => d.item.number === n)!;
    expect(involvesMe(by(1), { login: "old-name", id: ME })).toBe(true);
    expect(involvesMe(by(2), { login: "old-name", id: ME })).toBe(false);
    expect(involvesMe(by(3), { login: "old-name", id: ME })).toBe(true);
  });

  it("the digest's assigned-to-me section follows the assignee id", async () => {
    const d = await buildDigest(db, viewer, { now: NOW });
    const keys = d.undone.entries.map((e) => e.key);
    expect(keys).toContain(`wi:${(await row(1)).id}`);
    expect(keys).not.toContain(`wi:${(await row(2)).id}`);
    expect(keys).toContain(`wi:${(await row(3)).id}`);
  });

  it("changes-requested reaches an author who renamed, not whoever holds the old login", async () => {
    fake.items.set("acme/tool", [
      pr(4, { authorLogin: "renamed-me", authorGithubId: ME }),
      pr(5, { authorLogin: "old-name", authorGithubId: 9n }),
    ]);
    for (const n of [4, 5]) {
      fake.requested.set(`acme/tool#${n}`, { users: ["rev"], userGithubIds: [7n], teams: [] });
      fake.reviews.set(`acme/tool#${n}`, [{ githubId: BigInt(900 + n), login: "rev", userGithubId: 7n, state: "CHANGES_REQUESTED", body: null, commitSha: "head1", submittedAt: T(11) }]);
    }
    await sync(true);
    expect((await attention(db, viewer, { now: NOW })).changesRequested.map((d) => d.item.number)).toEqual([4]);
  });
});
