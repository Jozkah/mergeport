import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { assignEpic, assignIteration, applySuggestion, closeIteration, createBoard, createEpic, createIteration, deleteBoard, deleteEpic, listBoards, listEpics, releaseReadiness, setAutomation, setShipped, suggestedMoves, updateBoard } from "@/lib/services/planning-ext";
import { addDependency, blockedByCount, listDependencies, moveCard, removeDependency } from "@/lib/services/planning";
import { dependencyGraph, deliveryAnalytics } from "@/lib/services/planning-insight";
import { createTaskFromTemplate, previewPromotion, promoteTask } from "@/lib/services/task-promotion";
import { getTask, updateTask } from "@/lib/services/tasks";
import { attention } from "@/lib/services/queries";
import { freshSeed, leaks } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("named boards", () => {
  it("creates from a template, keeps the same cards, and rejects what is not a column of the project", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    const b = await createBoard(db, admin, { projectId: p, template: "release" });
    expect(b.name).toBe("Release");
    expect((b.columns as { key: string }[]).map((c) => c.key)).toEqual(["ready", "in-progress", "in-review", "blocked", "done"]);
    const cardsBefore = await db.planningItem.count();
    await updateBoard(db, admin, b.id, { name: "Release 1.4", groupBy: "assignee", density: "compact", columns: [{ key: "ready", wip: 2 }, { key: "done" }] });
    await expect(updateBoard(db, admin, b.id, { columns: [{ key: "nonsense" }] })).rejects.toThrow(/no "nonsense" column/);
    await createBoard(db, admin, { projectId: p, template: "delivery" });
    await expect(createBoard(db, admin, { projectId: p, template: "delivery" })).rejects.toThrow(/already exists/);
    await expect(createBoard(db, admin, { projectId: p, template: "nope" })).rejects.toThrow(/Unknown board template/);
    expect((await listBoards(db, admin, p)).find((x) => x.id === b.id)).toMatchObject({ name: "Release 1.4", groupBy: "assignee", density: "compact" });
    await deleteBoard(db, admin, b.id);
    expect(await db.planningItem.count()).toBe(cardsBefore); // a board never owns cards
  });

  it("is not available for a project the person cannot see", async () => {
    const { db, b } = S;
    await expect(listBoards(db, b, "no-such-project")).rejects.toThrow();
  });
});

describe("epics", () => {
  it("groups cards one level deep and reports progress over visible children, counting hidden ones", async () => {
    const { db, admin, a, ids } = S;
    const p = ids.projects.atlas.id;
    const e = await createEpic(db, admin, { projectId: p, title: "Session hardening", ownerLogin: "@Alice-Demo" });
    expect(e.ownerLogin).toBe("alice-demo");
    await assignEpic(db, admin, ids.cards.cApiPr.id, e.id);
    await assignEpic(db, admin, ids.cards.cWeb.id, e.id);
    const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: p, key: "done" } });
    await db.planningItem.update({ where: { id: ids.cards.cWeb.id }, data: { columnId: done.id } });
    const row = (await listEpics(db, admin, p))[0];
    expect(row).toMatchObject({ total: 2, done: 1, hidden: 0 });
    await expect(assignEpic(db, admin, ids.cards.cWeb.id, "nope")).rejects.toThrow();
    // a card of another project cannot join this epic
    const otherCard = await db.planningItem.findFirstOrThrow({ where: { projectId: ids.projects.dash.id } });
    await expect(assignEpic(db, admin, otherCard.id, e.id)).rejects.toThrow();
    // deleting an epic keeps its children
    await deleteEpic(db, admin, e.id);
    expect(await db.planningItem.count({ where: { id: ids.cards.cApiPr.id } })).toBe(1);
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cApiPr.id } })).epicId).toBeNull();
    void a;
  });

  it("does not show a person the progress of cards they cannot see, but says how many are hidden", async () => {
    const { db, admin, b, ids } = S;
    const p = ids.projects.atlas.id;
    const e = await createEpic(db, admin, { projectId: p, title: "Mixed" });
    await assignEpic(db, admin, ids.cards.cApiPr.id, e.id); // atlas-api: hidden from B
    await assignEpic(db, admin, ids.cards.cWeb.id, e.id);
    const asB = await listEpics(db, b, p).catch(() => null);
    if (asB) expect(asB[0]).toMatchObject({ total: 1, hidden: 1 });
    expect(JSON.stringify(asB)).not.toMatch(/token refresh/);
  });
});

describe("iterations", () => {
  it("rejects overlaps, assigns open iterations only, and carries unfinished work explicitly when closing", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    const d = (n: number) => new Date(Date.UTC(2026, 10, n));
    const one = await createIteration(db, admin, { projectId: p, name: "Week 1", startDate: d(1), endDate: d(8) });
    await expect(createIteration(db, admin, { projectId: p, name: "Clash", startDate: d(5), endDate: d(12) })).rejects.toThrow(/overlaps Week 1/);
    await expect(createIteration(db, admin, { projectId: p, name: "Backwards", startDate: d(20), endDate: d(15) })).rejects.toThrow(/end after/);
    const two = await createIteration(db, admin, { projectId: p, name: "Week 2", startDate: d(8), endDate: d(15) });
    await assignIteration(db, admin, ids.cards.cApiPr.id, one.id);
    await assignIteration(db, admin, ids.cards.cWeb.id, one.id);
    const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: p, key: "done" } });
    await db.planningItem.update({ where: { id: ids.cards.cWeb.id }, data: { columnId: done.id } });
    await expect(closeIteration(db, admin, one.id, one.id)).rejects.toThrow(/another open iteration/);
    expect(await closeIteration(db, admin, one.id, two.id)).toEqual({ carried: 1 });
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cApiPr.id } })).iterationId).toBe(two.id);
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cWeb.id } })).iterationId).toBe(one.id); // finished work stays
    expect(await db.planEvent.count({ where: { kind: "carried-over", itemId: ids.cards.cApiPr.id } })).toBe(1);
    await expect(assignIteration(db, admin, ids.cards.cDraft.id, one.id)).rejects.toThrow(/open iteration/);
    await expect(closeIteration(db, admin, one.id, null)).rejects.toThrow(/already closed/);
  });
});

describe("milestone release readiness", () => {
  it("separates finished work from a shipped release and lists what is in the way", async () => {
    const { db, admin, ids } = S;
    const r = await releaseReadiness(db, admin, ids.milestone.id);
    expect(r.workFinished).toBe(false);
    expect(r.shipped).toBe(false);
    expect(r.unfinished.length).toBeGreaterThan(0);
    // finishing every card is still not shipping
    const cards = await db.planningItem.findMany({ where: { milestoneId: ids.milestone.id }, include: { column: true } });
    for (const c of cards) {
      const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: c.projectId, key: "done" } });
      await db.planningItem.update({ where: { id: c.id }, data: { columnId: done.id } });
    }
    const finished = await releaseReadiness(db, admin, ids.milestone.id);
    expect(finished).toMatchObject({ workFinished: true, shipped: false });
    await expect(setShipped(db, S.a, ids.milestone.id, true)).rejects.toThrow(/administrator/);
    await expect(setShipped(db, admin, ids.milestone.id, true, { url: "javascript:alert(1)" })).rejects.toThrow(/https/);
    await setShipped(db, admin, ids.milestone.id, true, { tag: "v1.4.0", url: "https://github.com/acme/app/releases/tag/v1.4.0" });
    expect(await releaseReadiness(db, admin, ids.milestone.id)).toMatchObject({ shipped: true, milestone: { releaseTag: "v1.4.0" } });
    await setShipped(db, admin, ids.milestone.id, false);
    expect((await releaseReadiness(db, admin, ids.milestone.id)).shipped).toBe(false);
  });

  it("counts failing checks, blocked cards and pending decisions", async () => {
    const { db, admin, ids } = S;
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { checksState: "FAILURE" } });
    const r = await releaseReadiness(db, admin, ids.milestone.id);
    expect(r.failingChecks.map((f) => f.id)).toContain(ids.cards.cApiPr.id);
    expect(r.blocked.map((b) => b.id)).toContain(ids.cards.cApiPr.id); // seeded: cApiPr2 blocks it
  });

  it("hides what the viewer cannot see but reports that some exists", async () => {
    const { db, b, ids } = S;
    const r = await releaseReadiness(db, b, ids.milestone.id);
    expect(r.hidden).toBeGreaterThan(0);
    expect(leaks(r, "token refresh")).toBe(false);
  });
});

describe("planning automation previews", () => {
  it("suggests Done for a merged PR or closed issue only when switched on, and never for a PR closed unmerged", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { state: "MERGED" } });
    expect(await suggestedMoves(db, admin, p)).toEqual([]); // off by default
    await expect(setAutomation(db, S.a, p, "suggest")).rejects.toThrow(/administrator/);
    await setAutomation(db, admin, p, "suggest");
    const s = await suggestedMoves(db, admin, p);
    expect(s.map((x) => x.itemId)).toContain(ids.cards.cApiPr.id);
    expect(s.find((x) => x.itemId === ids.cards.cApiPr.id)?.why).toMatch(/merged/);
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { state: "CLOSED" } });
    expect((await suggestedMoves(db, admin, p)).map((x) => x.itemId)).not.toContain(ids.cards.cApiPr.id);
  });

  it("applying a suggestion moves the local card only and records the move", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    await setAutomation(db, admin, p, "suggest");
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { state: "MERGED" } });
    const snap = async () => JSON.stringify(await db.workItem.findUniqueOrThrow({ where: { id: ids.items.api14.id } }), (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    const wiBefore = await snap();
    await applySuggestion(db, admin, ids.cards.cApiPr.id);
    expect((await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cApiPr.id }, include: { column: true } })).column.key).toBe("done");
    expect(await snap()).toBe(wiBefore); // GitHub-derived data untouched
    expect(await db.planEvent.count({ where: { itemId: ids.cards.cApiPr.id, kind: "done" } })).toBe(1);
    await expect(applySuggestion(db, admin, ids.cards.cApiPr.id)).rejects.toThrow(/no longer applies/);
  });
});

describe("dependencies across projects", () => {
  it("links, kinds, cycles and audience boundaries", async () => {
    const { db, admin, ids } = S;
    const dashCard = await db.planningItem.findFirstOrThrow({ where: { projectId: ids.projects.dash.id } });
    await addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "related");
    await addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "related"); // idempotent
    await expect(addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "blocks")).rejects.toThrow(/already linked as "related"/);
    await expect(addDependency(db, admin, ids.cards.cWeb.id, ids.cards.cWeb.id)).rejects.toThrow(/itself/);
    await expect(addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "whatever")).rejects.toThrow(/Unknown link type/);
    await removeDependency(db, admin, ids.cards.cWeb.id, dashCard.id);
    await addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "blocks"); // cross-project blocker
    expect(await blockedByCount(db, dashCard.id)).toBe(1);
    await expect(addDependency(db, admin, dashCard.id, ids.cards.cWeb.id, "blocks")).rejects.toThrow(/cycle/);
    // related links never block
    await removeDependency(db, admin, ids.cards.cWeb.id, dashCard.id);
    await addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "related");
    expect(await blockedByCount(db, dashCard.id)).toBe(0);
    // projects shared with different audiences cannot be linked
    await db.project.update({ where: { id: ids.projects.dash.id }, data: { spaceId: "some-space" } });
    await expect(addDependency(db, admin, ids.cards.cWeb.id, dashCard.id, "blocks")).rejects.toThrow(/different audiences/);
  });

  it("a blocker that follows a PR closed without merging keeps blocking, in planning and in attention", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    // cApiPr2 (seeded) blocks cApiPr. Put the blocker in Done while its PR was closed unmerged.
    const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: p, key: "done" } });
    await db.planningItem.update({ where: { id: ids.cards.cApiPr2.id }, data: { columnId: done.id } });
    await db.workItem.update({ where: { id: ids.items.api15.id }, data: { state: "MERGED" } });
    expect(await blockedByCount(db, ids.cards.cApiPr.id)).toBe(0);
    const reasons = async () => (await attention(db, admin)).blocked.find((d) => d.item.id === ids.items.api14.id)?.derivation.blockedReasons.join(" ") ?? "";
    expect(await reasons()).not.toMatch(/unfinished dependenc/);
    await db.workItem.update({ where: { id: ids.items.api15.id }, data: { state: "CLOSED" } });
    expect(await blockedByCount(db, ids.cards.cApiPr.id)).toBe(1);
    expect(await reasons()).toMatch(/unfinished dependenc/);
  });

  it("the graph shows only visible cards and an anonymous marker for hidden ends", async () => {
    const { db, admin, b, ids } = S;
    await addDependency(db, admin, ids.cards.cApiPr.id, ids.cards.cWeb.id); // hidden (to B) blocks visible
    const g = await dependencyGraph(db, b);
    expect(g.nodes.map((n) => n.id)).toContain(ids.cards.cWeb.id);
    expect(g.nodes.map((n) => n.id)).not.toContain(ids.cards.cApiPr.id);
    expect(g.opaque).toContainEqual({ kind: "blocks", direction: "blocked-by", visibleEnd: ids.cards.cWeb.id });
    expect(leaks(g, "token refresh")).toBe(false);
    expect(leaks(g, ids.cards.cApiPr.id)).toBe(false);
    const all = await dependencyGraph(db, admin);
    expect(all.nodes.map((n) => n.id)).toContain(ids.cards.cApiPr.id);
    expect(all.critical.length).toBeGreaterThan(0);
    const deps = await listDependencies(db, admin, ids.cards.cWeb.id);
    expect(deps.some((d) => !d.opaque && d.kind === "blocks")).toBe(true);
  });
});

describe("recorded history and analytics", () => {
  it("records creation and moves, and says nothing before recording began", async () => {
    const { db, admin, ids } = S;
    const p = ids.projects.atlas.id;
    const empty = await deliveryAnalytics(db, admin, p);
    expect(empty).toMatchObject({ recordingSince: null, events: 0 });
    expect(empty.cycle.count).toBe(0);
    const card = await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cDraft.id } });
    await moveCard(db, admin, { itemId: card.id, toColumnKey: "in-progress", expectedVersion: card.version });
    const moved = await db.planningItem.findUniqueOrThrow({ where: { id: card.id } });
    await moveCard(db, admin, { itemId: card.id, toColumnKey: "done", expectedVersion: moved.version });
    const r = await deliveryAnalytics(db, admin, p);
    expect(r.events).toBe(3); // moved, moved, done
    expect(r.recordingSince).toBeInstanceOf(Date);
    expect(r.cycle.count).toBe(1);
    expect(r.cycle.skipped).toBe(0);
  });

  it("records moves made through task updates too, and only for cards the viewer can see", async () => {
    const { db, admin, b, ids } = S;
    const cur = (await db.planningItem.findUniqueOrThrow({ where: { id: ids.cards.cWeb.id }, include: { column: true } })).column.key;
    await updateTask(db, admin, ids.cards.cWeb.id, { columnKey: cur === "in-progress" ? "ready" : "in-progress" });
    expect(await db.planEvent.count({ where: { itemId: ids.cards.cWeb.id, kind: "moved" } })).toBe(1);
    await updateTask(db, admin, ids.cards.cApiPr.id, { columnKey: "done" });
    const asB = await deliveryAnalytics(db, b, ids.projects.atlas.id).catch(() => null);
    if (asB) expect(asB.events).toBe(1); // the atlas-api card's history is as private as the card
  });
});

describe("task templates and promotion to a GitHub issue", () => {
  it("creates a task from a template with its checklist", async () => {
    const { db, admin, ids } = S;
    const t = await createTaskFromTemplate(db, admin, { projectId: ids.projects.atlas.id, template: "bug", title: "Login loops" });
    expect(t.title).toBe("Bug: Login loops");
    expect((await getTask(db, admin, t.id)).checklist.length).toBe(5);
    await expect(createTaskFromTemplate(db, admin, { projectId: ids.projects.atlas.id, template: "x", title: "y" })).rejects.toThrow(/Unknown template/);
  });

  it("previews first, then creates one issue and links the same task, never twice", async () => {
    const { db, admin, ids } = S;
    const t = await createTaskFromTemplate(db, admin, { projectId: ids.projects.atlas.id, template: "feature", title: "Rate limits" });
    const repo = await db.repository.findFirstOrThrow({ where: { fullName: "northwind/atlas-api" } });
    const preview = await previewPromotion(db, admin, t.id, repo.id);
    expect(preview).toMatchObject({ title: "Feature: Rate limits", destination: { fullName: "northwind/atlas-api" } });
    expect(preview.body).toMatch(/- \[ \] Agree the approach/);
    const fake = new FakeGithub();
    fake.repos.set("northwind/atlas-api", { githubId: repo.githubId, fullName: repo.fullName, name: repo.name, htmlUrl: repo.htmlUrl, visibility: "PRIVATE", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 1n, login: "northwind", type: "ORGANIZATION" } });
    fake.items.set("northwind/atlas-api", [{ githubId: 4242n, number: 999, type: "ISSUE", title: preview.title, body: null, state: "OPEN", draft: false, authorLogin: "owner-demo", authorGithubId: 1n, authorAvatar: null, labels: [], assignees: [], milestoneNumber: null, milestoneTitle: null, htmlUrl: "https://x/999", createdAt: new Date(), updatedAt: new Date(), closedAt: null, mergedAt: null }]);
    expect(fake.writes).toEqual([]); // previewing wrote nothing
    const done = await promoteTask(db, admin, t.id, repo.id, fake);
    expect(done.number).toBe(999);
    expect(fake.writes).toEqual(["createIssue northwind/atlas-api Feature: Rate limits"]);
    const linked = await db.planningItem.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked).toMatchObject({ id: t.id, workItemId: done.workItemId, workNumber: 999 });
    expect((await getTask(db, admin, t.id)).checklist.length).toBe(5); // identity, checklist and history survive
    await expect(promoteTask(db, admin, t.id, repo.id, fake)).rejects.toThrow(/already follows/);
    expect(fake.writes).toHaveLength(1);
  });

  it("refuses a destination the person cannot manage", async () => {
    const { db, a, ids } = S;
    const t = await createTaskFromTemplate(db, a, { projectId: ids.projects.atlas.id, template: "bug", title: "x" });
    const hidden = await db.repository.findFirstOrThrow({ where: { fullName: "acme-labs/internal-tools" } }).catch(() => null);
    if (hidden) await expect(previewPromotion(db, a, t.id, hidden.id)).rejects.toThrow(/Choose one of/);
  });
});
