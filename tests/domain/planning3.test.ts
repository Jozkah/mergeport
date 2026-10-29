import { describe, expect, it } from "vitest";
import { BOARD_TEMPLATES, cleanBoardColumns, groupCards, wipState } from "@/lib/domain/boards";
import { blockerFinished, blocksCycle, criticalBlockers, layers } from "@/lib/domain/deps";
import { agingWip, cycleTimes, recordingSince, scopeAdded, type Ev } from "@/lib/domain/analytics";
import { TASK_TEMPLATES, templateByKey } from "@/lib/domain/task-templates";

const KEYS = ["backlog", "ready", "in-progress", "in-review", "blocked", "done"];
const h = (n: number) => new Date(Date.UTC(2026, 9, 1, n));

describe("board configuration", () => {
  it("every built-in template is valid for the default columns", () => {
    for (const t of BOARD_TEMPLATES) expect(() => cleanBoardColumns(t.columns, KEYS)).not.toThrow();
    expect(BOARD_TEMPLATES.map((t) => t.key)).toEqual(["delivery", "maintenance", "external", "release"]);
  });

  it("rejects unknown, repeated and empty columns, and bad limits", () => {
    expect(() => cleanBoardColumns([], KEYS)).toThrow(/at least one/);
    expect(() => cleanBoardColumns([{ key: "nope" }], KEYS)).toThrow(/no "nope" column/);
    expect(() => cleanBoardColumns([{ key: "done" }, { key: "done" }], KEYS)).toThrow(/only appear once/);
    expect(() => cleanBoardColumns([{ key: "done", wip: 0 }], KEYS)).toThrow(/whole number/);
    expect(() => cleanBoardColumns([{ key: "done", wip: 2.5 }], KEYS)).toThrow(/whole number/);
    expect(cleanBoardColumns([{ key: "done", name: "  Shipped ", wip: 3 }, { key: "ready", wip: null }], KEYS)).toEqual([{ key: "done", name: "Shipped", wip: 3 }, { key: "ready", wip: null }]);
  });

  it("flags a column at or over its limit but never blocks", () => {
    expect([wipState(2, 3), wipState(3, 3), wipState(4, 3), wipState(9, null)]).toEqual(["ok", "at", "over", "none"]);
  });

  it("groups the same cards into lanes without duplicating any, with the empty lane last", () => {
    const cards = [
      { id: "1", repoFullName: "a/x", assignee: "bo", milestoneName: null, epicTitle: null },
      { id: "2", repoFullName: "a/x", assignee: null, milestoneName: "M1", epicTitle: "E" },
      { id: "3", repoFullName: null, assignee: "al", milestoneName: "M1", epicTitle: null },
    ];
    const lanes = groupCards(cards, "repository");
    expect(lanes.map((l) => l.title)).toEqual(["a/x", "No repository (local tasks)"]);
    expect(lanes.flatMap((l) => l.cards.map((c) => c.id)).sort()).toEqual(["1", "2", "3"]);
    expect(groupCards(cards, "assignee").map((l) => l.title)).toEqual(["al", "bo", "Unassigned"]);
    expect(groupCards(cards, "milestone").map((l) => l.title)).toEqual(["M1", "No milestone"]);
    expect(groupCards(cards, "epic").map((l) => l.title)).toEqual(["E", "No epic"]);
    expect(groupCards(cards, "none")).toHaveLength(1);
  });
});

describe("dependency rules", () => {
  it("a blocker is finished only when done, and a closed unmerged PR never counts as delivered", () => {
    expect(blockerFinished({ columnKey: "done", workType: null, workState: null })).toBe(true);
    expect(blockerFinished({ columnKey: "done", workType: "PULL_REQUEST", workState: "MERGED" })).toBe(true);
    expect(blockerFinished({ columnKey: "done", workType: "PULL_REQUEST", workState: "CLOSED" })).toBe(false);
    expect(blockerFinished({ columnKey: "done", workType: "ISSUE", workState: "CLOSED" })).toBe(true); // a closed issue is resolved work
    expect(blockerFinished({ columnKey: "in-review", workType: "PULL_REQUEST", workState: "MERGED" })).toBe(false);
  });

  it("only blocking links form cycles", () => {
    const e = [{ from: "a", to: "b", kind: "blocks" as const }, { from: "b", to: "c", kind: "blocks" as const }, { from: "c", to: "z", kind: "related" as const }];
    expect(blocksCycle(e, "c", "a")).toBe(true);
    expect(blocksCycle(e, "z", "a")).toBe(false); // z is only related to c
    expect(blocksCycle(e, "a", "a")).toBe(true);
  });

  it("ranks critical blockers by how much open work they hold back, ignoring finished work", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, finished: id === "d" }));
    const edges = [{ from: "a", to: "b", kind: "blocks" as const }, { from: "b", to: "c", kind: "blocks" as const }, { from: "d", to: "a", kind: "blocks" as const }, { from: "c", to: "a", kind: "related" as const }];
    expect(criticalBlockers(nodes, edges)).toEqual([{ id: "a", holdsBack: 2 }, { id: "b", holdsBack: 1 }]);
    expect(layers(["a", "b", "c", "d"], edges).get("c")).toBe(3); // d, a, b come before it
  });
});

describe("delivery analytics are built from recorded events only", () => {
  const ev = (itemId: string, kind: string, toKey: string | null, at: Date, extra: Partial<Ev> = {}): Ev => ({ itemId, kind, fromKey: null, toKey, refId: null, at, ...extra });

  it("measures cycle time only for items whose start and finish were both recorded", () => {
    const events = [
      ev("a", "created", "backlog", h(0)), ev("a", "moved", "in-progress", h(2)), ev("a", "done", "done", h(10)),
      ev("b", "moved", "in-progress", h(1)), ev("b", "done", "done", h(5)),
      ev("c", "done", "done", h(6)), // finished, start never recorded
    ];
    const c = cycleTimes(events);
    expect(c).toMatchObject({ count: 2, skipped: 1 });
    expect(c.medianMs).toBe(6 * 3_600_000); // (8h + 4h) / 2
  });

  it("reports nothing rather than inventing a history", () => {
    expect(cycleTimes([])).toEqual({ count: 0, medianMs: null, p85Ms: null, skipped: 0 });
    expect(recordingSince([])).toBeNull();
    const { aging, unrecorded } = agingWip([{ id: "x", columnKey: "in-progress" }], [], h(10));
    expect(aging).toEqual([]);
    expect(unrecorded).toBe(1);
  });

  it("ages work from the recorded entry into its current column", () => {
    const events = [ev("x", "moved", "in-progress", h(2)), ev("x", "moved", "in-review", h(6)), ev("y", "moved", "in-progress", h(1))];
    const r = agingWip([{ id: "x", columnKey: "in-review" }, { id: "y", columnKey: "in-progress" }, { id: "z", columnKey: "done" }], events, h(10));
    expect(r.aging).toEqual([{ itemId: "y", columnKey: "in-progress", sinceMs: 9 * 3_600_000 }, { itemId: "x", columnKey: "in-review", sinceMs: 4 * 3_600_000 }]);
  });

  it("counts scope added after a milestone started, using recorded additions", () => {
    const events = [ev("a", "milestone", null, h(1), { refId: "m" }), ev("b", "milestone", null, h(8), { refId: "m" }), ev("c", "milestone", null, h(9), { refId: "other" })];
    expect(scopeAdded(events, "m", h(5))).toEqual({ added: 1, atStart: 1 });
    expect(scopeAdded(events, "m", null)).toBeNull();
  });
});

describe("task templates", () => {
  it("offers bug, feature, review and release checklist, each with a checklist", () => {
    expect(TASK_TEMPLATES.map((t) => t.key)).toEqual(["bug", "feature", "review", "release"]);
    for (const t of TASK_TEMPLATES) {
      expect(t.checklist.length).toBeGreaterThan(2);
      expect(templateByKey(t.key)).toBe(t);
    }
    expect(templateByKey("x")).toBeNull();
  });
});
