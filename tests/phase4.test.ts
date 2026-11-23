import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { GithubError } from "@/lib/github/port";
import { syncRepository } from "@/lib/sync/repository";
import { compareFilesView, pullFilesView } from "@/lib/services/git-view";
import { addDraft, deleteDraft, discardDrafts, listDrafts, pullOwnersView, reviewThreads, submitDrafts } from "@/lib/services/review-extras";
import { addMapping, deleteMapping, labelFilter, taxonomy } from "@/lib/services/label-taxonomy";
import { createAdoption, createSubscription, deleteBackport, deleteSubscription, listBackports, listSubscriptions, previewAdoption, recordBackport, setSubscriptionMuted, upstreamRelevance } from "@/lib/services/upstream-extras";
import { listWorkItems } from "@/lib/services/queries";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});
const NL = String.fromCharCode(10);

describe("CODEOWNERS routing", () => {
  it("routes the PR's files to owners from the base branch's file, beside what Mergeport already knows", async () => {
    const { db, admin, ids } = S;
    await db.workItem.update({ where: { id: ids.items.web9.id }, data: { baseRef: "main" } });
    const fake = new FakeGithub();
    fake.files.set("northwind/atlas-web:main:.github/CODEOWNERS", ["* @alice-demo", "/src/ @northwind/web-team", "docs/** nobody-valid"].join(NL));
    const v = await pullOwnersView(db, admin, ids.items.web9.id, fake);
    expect(v.file).toEqual({ path: ".github/CODEOWNERS", branch: "main" });
    expect(v.requirement).toBe("unknown"); // routing is advice; GitHub's own requirement is not read
    expect(v.rows.length).toBeGreaterThan(0);
    const team = v.rows.find((r) => r.kind === "team");
    if (team) expect(team.status).toBe("unknown"); // team membership is not readable
    const alice = v.rows.find((r) => r.owner === "@alice-demo");
    if (alice) expect(["approved", "pending", "not-requested", "changes-requested"]).toContain(alice.status);
    expect(v.otherSources.length).toBeGreaterThan(0);
  });

  it("says so when there is no CODEOWNERS file, and refuses items the viewer cannot see", async () => {
    const { db, admin, b, ids } = S;
    const v = await pullOwnersView(db, admin, ids.items.web9.id, new FakeGithub());
    expect(v.file).toBeNull();
    expect(v.notes[0]).toMatch(/no CODEOWNERS file/);
    await expect(pullOwnersView(db, b, ids.items.api14.id, new FakeGithub())).rejects.toThrow();
  });
});

describe("draft review batches", () => {
  it("collects comments privately, then sends one review with all of them", async () => {
    const { db, admin, ids } = S;
    const id = ids.items.web9.id;
    await db.workItem.update({ where: { id }, data: { headSha: "a".repeat(40), authorLogin: "someone-else" } });
    await addDraft(db, admin, id, { path: "src/session.ts", line: 4, body: "  nit: rename  " });
    await addDraft(db, admin, id, { path: "src/session.ts", line: 9, side: "LEFT", body: "why was this removed?" });
    const drafts = await listDrafts(db, admin, id);
    expect(drafts.map((d) => [d.line, d.side, d.body, d.stale])).toEqual([[4, "RIGHT", "nit: rename", false], [9, "LEFT", "why was this removed?", false]]);
    const fake = new FakeGithub();
    const r = await submitDrafts({ db, v: admin, port: fake }, id, { event: "REQUEST_CHANGES", body: "A few things" });
    expect(r.comments).toBe(2);
    expect(fake.writes).toEqual(["review northwind/atlas-web#9 REQUEST_CHANGES +2 comments"]); // one request, not one per comment
    expect(await listDrafts(db, admin, id)).toEqual([]);
  });

  it("keeps the drafts when GitHub refuses, and refuses drafts written on an older version", async () => {
    const { db, admin, ids } = S;
    const id = ids.items.web9.id;
    await db.workItem.update({ where: { id }, data: { headSha: "a".repeat(40), authorLogin: "someone-else" } });
    await addDraft(db, admin, id, { path: "a.ts", line: 1, body: "x" });
    const failing = new FakeGithub();
    failing.submitReview = async () => {
      throw new GithubError("network", "boom");
    };
    await expect(submitDrafts({ db, v: admin, port: failing }, id, { event: "COMMENT", body: "" })).rejects.toThrow();
    expect(await listDrafts(db, admin, id)).toHaveLength(1);
    await db.workItem.update({ where: { id }, data: { headSha: "b".repeat(40) } }); // the PR moved
    expect((await listDrafts(db, admin, id))[0].stale).toBe(true);
    await expect(submitDrafts({ db, v: admin, port: new FakeGithub() }, id, { event: "COMMENT", body: "" })).rejects.toThrow(/older version/);
  });

  it("is personal, validated, and cannot approve your own PR or an empty review", async () => {
    const { db, admin, a, ids } = S;
    const id = ids.items.web9.id;
    await db.workItem.update({ where: { id }, data: { headSha: "a".repeat(40) } });
    await expect(addDraft(db, admin, id, { path: "a.ts", line: 0, body: "x" })).rejects.toThrow(/Choose a line/);
    await expect(addDraft(db, admin, id, { path: "a.ts", line: 2, body: "  " })).rejects.toThrow(/Write the comment/);
    const d = await addDraft(db, admin, id, { path: "a.ts", line: 2, body: "mine" });
    expect(await listDrafts(db, a, id)).toEqual([]); // someone else's pending review is invisible to them
    await expect(deleteDraft(db, a, d.id)).rejects.toThrow();
    await db.workItem.update({ where: { id }, data: { authorLogin: admin.login } });
    await expect(submitDrafts({ db, v: admin, port: new FakeGithub() }, id, { event: "APPROVE", body: "" })).rejects.toThrow(/own pull request/);
    await discardDrafts(db, admin, id);
    await db.workItem.update({ where: { id }, data: { authorLogin: "someone-else" } });
    await expect(submitDrafts({ db, v: admin, port: new FakeGithub() }, id, { event: "COMMENT", body: "" })).rejects.toThrow(/explain/);
  });
});

describe("review threads", () => {
  it("reads GitHub's resolved flag, treats never-read as unknown, and keeps it when the read fails", async () => {
    const { db, admin, ids } = S;
    const id = ids.items.web9.id;
    const wi = await db.workItem.findUniqueOrThrow({ where: { id }, include: { repository: { include: { owner: true } } } });
    await db.workItemComment.createMany({ data: [
      { workItemId: id, githubId: 70n, kind: "REVIEW_COMMENT", authorLogin: "r", body: "open one", path: "a.ts", line: 3, threadKey: "70", createdAtGh: new Date(), updatedAtGh: new Date() },
      { workItemId: id, githubId: 71n, kind: "REVIEW_COMMENT", authorLogin: "r", body: "done one", path: "b.ts", line: 5, threadKey: "71", createdAtGh: new Date(), updatedAtGh: new Date() },
      { workItemId: id, githubId: 72n, kind: "REVIEW_COMMENT", authorLogin: "r", body: "never read", path: "c.ts", line: 1, threadKey: "72", createdAtGh: new Date(), updatedAtGh: new Date() },
    ] });
    expect((await reviewThreads(db, admin, id)).unknown).toBe(3);
    // Sync with a fake GitHub that knows these comments and two thread states
    const fake = new FakeGithub();
    const key = `${wi.repository.owner.login}/${wi.repository.name}`;
    const meta = { githubId: wi.repository.githubId, fullName: wi.repository.fullName, name: wi.repository.name, htmlUrl: wi.repository.htmlUrl, visibility: "PRIVATE" as const, isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 1n, login: wi.repository.owner.login, type: "ORGANIZATION" as const } };
    fake.repos.set(key, meta);
    fake.items.set(key, [{ githubId: wi.githubId, number: wi.number, type: "PULL_REQUEST", title: wi.title, body: null, state: "OPEN", draft: false, authorLogin: wi.authorLogin, authorGithubId: 1n, authorAvatar: null, labels: [], assignees: [], milestoneNumber: null, milestoneTitle: null, htmlUrl: wi.htmlUrl, createdAt: wi.createdAtGh, updatedAt: new Date(), closedAt: null, mergedAt: null, headSha: wi.headSha ?? "h", headRef: "f", baseRef: "main", mergeable: "MERGEABLE" }]);
    fake.branches.set(key, [{ name: "main", sha: "m", isDefault: true }]);
    const mk = (n: bigint, body: string, path: string, line: number) => ({ githubId: n, login: "r", body, createdAt: new Date(), updatedAt: new Date(), path, line, commitSha: "h", threadKey: n.toString() });
    fake.reviewComments.set(`${key}#${wi.number}`, [mk(70n, "open one", "a.ts", 3), mk(71n, "done one", "b.ts", 5), mk(72n, "never read", "c.ts", 1)]);
    fake.threads.set(`${key}#${wi.number}`, [{ rootCommentId: 70n, resolved: false }, { rootCommentId: 71n, resolved: true }]);
    await syncRepository(db, fake, wi.repositoryId, { now: new Date(), full: true });
    const t = await reviewThreads(db, admin, id);
    expect(t).toMatchObject({ unresolved: 1, unknown: 1 });
    expect(t.threads.find((x) => x.key === "71")!.resolved).toBe(true);
    expect(t.githubUrl).toMatch(/\/files$/);
    fake.threads.set(`${key}#${wi.number}`, []);
    await syncRepository(db, fake, wi.repositoryId, { now: new Date(), full: true });
    expect((await reviewThreads(db, admin, id)).unresolved).toBe(1); // an empty answer changes nothing
  });
});

describe("comparing review versions", () => {
  it("shows what changed between two commits, remembers full-id answers, and validates ids", async () => {
    const { db, admin, b, ids } = S;
    const id = ids.items.web9.id;
    const from = "a".repeat(40);
    const to = "b".repeat(40);
    const r = await compareFilesView(db, admin, id, from, to);
    expect(r.files.length).toBeGreaterThan(0);
    expect(await db.gitCache.count({ where: { key: { startsWith: "cmp:1:" } } })).toBe(1);
    expect((await compareFilesView(db, admin, id, from, from)).files).toEqual([]);
    await expect(compareFilesView(db, admin, id, "../x", to)).rejects.toThrow(/not a commit id/);
    await expect(compareFilesView(db, b, ids.items.api14.id, from, to)).rejects.toThrow();
    const files = await pullFilesView(db, admin, id, false);
    expect(files.lastReviewedSha).toBeNull();
    await db.workItemComment.create({ data: { workItemId: id, githubId: 9001n, kind: "REVIEW", authorLogin: admin.login, reviewState: "APPROVED", commitSha: from, createdAtGh: new Date(), updatedAtGh: new Date() } });
    expect((await pullFilesView(db, admin, id, false)).lastReviewedSha).toBe(from);
  });
});

describe("scoped labels", () => {
  it("maps spellings to concepts for admins, filters lists by concept, and previews counts", async () => {
    const { db, admin, a, ids } = S;
    await expect(addMapping(db, a, { concept: "type::bug", spelling: "bug" })).rejects.toThrow(/administrator/);
    await expect(addMapping(db, admin, { concept: "bug", spelling: "bug" })).rejects.toThrow(/family::value/);
    await expect(addMapping(db, admin, { concept: "type::bug", spelling: "type::defect" })).rejects.toThrow(/already means itself/);
    const m = await addMapping(db, admin, { concept: "Type::Bug", spelling: "bug" });
    expect(m.concept).toBe("type::bug");
    await expect(addMapping(db, admin, { concept: "type::bug", spelling: "bug" })).rejects.toThrow(/already mapped/);
    const t = await taxonomy(db, admin);
    expect(t.families).toEqual(expect.arrayContaining([{ family: "type", values: ["bug"] }]));
    expect(t.preview[0]).toMatchObject({ concept: "type::bug", spelling: "bug" });
    expect(t.preview[0].items).toBeGreaterThan(0);
    const before = await db.workItem.count();
    const list = await listWorkItems(db, admin, { type: "PULL_REQUEST", state: "ALL", label: "type::bug", page: 1, pageSize: 50 });
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.rows.every((r) => JSON.stringify(r.labels).includes("bug"))).toBe(true);
    expect(await db.workItem.count()).toBe(before); // labels on the items themselves were never rewritten
    expect((await labelFilter(db, admin, "type::bug")).OR).toHaveLength(2);
    await deleteMapping(db, admin, m.id);
    expect((await listWorkItems(db, admin, { type: "PULL_REQUEST", state: "ALL", label: "type::bug", page: 1, pageSize: 50 })).rows).toHaveLength(0);
    void ids;
  });
});

describe("upstream subscriptions", () => {
  it("selects upstream items with the reason, honours mute, and is admin-managed", async () => {
    const { db, admin, a, ids } = S;
    const map = ids.map;
    await expect(createSubscription(db, a, { name: "x", criteria: { labels: ["a"] } })).rejects.toThrow(/administrator/);
    await expect(createSubscription(db, admin, { name: "x", criteria: {} })).rejects.toThrow(/at least one/);
    const core = await db.workItem.findFirstOrThrow({ where: { repositoryId: map.upstreamRepoId, number: 101 } });
    const word = core.title.split(" ")[0];
    const s = await createSubscription(db, admin, { name: "Watch", mappingId: map.id, criteria: { titleContains: [word], paths: ["src/nowhere/"] } });
    const r = await upstreamRelevance(db, admin, map.id);
    expect(r.prs[101][0].reasons[0]).toMatch(/mentions/);
    expect(r.prs[101][0].unknown[0]).toMatch(/not loaded/); // the path criterion could not be checked, and says so
    await setSubscriptionMuted(db, admin, s.id, true);
    expect(await upstreamRelevance(db, admin, map.id)).toEqual({ issues: {}, prs: {} });
    expect((await listSubscriptions(db, admin))[0]).toMatchObject({ muted: true, mappingName: expect.any(String) });
    await deleteSubscription(db, admin, s.id);
    expect(await listSubscriptions(db, admin)).toEqual([]);
  });
});

describe("backport records", () => {
  it("keeps evidence and decision apart: manual never overwrites verified evidence", async () => {
    const { db, admin, ids } = S;
    const base = { mappingId: ids.map.id, upstreamNumber: 102, targetBranch: "main" };
    await expect(recordBackport(db, admin, { ...base, upstreamNumber: 0, state: "planned" })).rejects.toThrow(/upstream number/);
    await expect(recordBackport(db, admin, { ...base, targetBranch: "a..b", state: "planned" })).rejects.toThrow(/branch/);
    const planned = await recordBackport(db, admin, { ...base, state: "planned", note: "next sprint" });
    expect(planned).toMatchObject({ state: "planned", evidence: "unknown" });
    await db.backportRecord.update({ where: { id: planned.id }, data: { evidence: "patch-equivalent", localSha: "c".repeat(40) } });
    const done = await recordBackport(db, admin, { ...base, state: "done" });
    expect(done).toMatchObject({ state: "done", evidence: "patch-equivalent" }); // the person's decision did not erase what Git showed
    expect((await listBackports(db, admin, ids.map.id)).map((b) => b.upstreamNumber)).toEqual([102]);
    await deleteBackport(db, admin, done.id);
    expect(await listBackports(db, admin, ids.map.id)).toEqual([]);
  });

});

describe("adoption planner", () => {
  it("previews first, then creates a milestone, one task per change, planned backports and a final sync step they all block", async () => {
    const { db, admin, a, ids } = S;
    const input = { mappingId: ids.map.id, items: [{ kind: "pr" as const, number: 101 }, { kind: "pr" as const, number: 102 }], targetBranch: "release/1.4", projectId: ids.projects.dash.id };
    const p = await previewAdoption(db, admin, input);
    expect(p.tasks).toHaveLength(2);
    expect(p.finalStep.title).toMatch(/^Sync /);
    expect(p.notes[0]).toMatch(/Nothing is changed on GitHub/);
    expect(await db.dashboardMilestone.count({ where: { name: p.milestoneName } })).toBe(0); // previewing wrote nothing
    await expect(previewAdoption(db, admin, { ...input, items: [] })).rejects.toThrow(/at least one/);
    await expect(previewAdoption(db, admin, { ...input, items: [{ kind: "pr", number: 9999 }] })).rejects.toThrow(/not tracked/);
    await expect(previewAdoption(db, admin, { ...input, targetBranch: "a..b" })).rejects.toThrow(/branch/);
    await expect(createAdoption(db, a, input)).rejects.toThrow(/administrator/);
    const r = await createAdoption(db, admin, input);
    expect(r.taskIds).toHaveLength(2);
    expect(await db.planningItem.count({ where: { milestoneId: r.milestoneId } })).toBe(3);
    expect(await db.planningLink.count({ where: { toId: r.finalTaskId, kind: "blocks" } })).toBe(2);
    expect((await listBackports(db, admin, ids.map.id)).map((b) => [b.upstreamNumber, b.targetBranch, b.state])).toEqual([[101, "release/1.4", "planned"], [102, "release/1.4", "planned"]]);
  });
});
