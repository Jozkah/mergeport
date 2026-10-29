import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { parseQuickActions } from "@/lib/domain/quick-actions";
import { applyQuick, previewQuick } from "@/lib/services/quick-actions";
import { createTask, getTask } from "@/lib/services/tasks";
import { freshSeed } from "./helpers";

const NL = String.fromCharCode(10);
let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("quick action parsing", () => {
  it("reads each command and leaves ordinary text as the comment", () => {
    const p = parseQuickActions(["Looks good, shipping it", "/assign @Alice-Demo", "/priority high", "/due 2026-11-05", "/label bug, ~ui", "/unlabel old", "/move In progress"].join(NL));
    expect(p.rest).toBe("Looks good, shipping it");
    expect(p.errors).toEqual([]);
    expect(p.ops).toEqual([
      { kind: "assign", login: "Alice-Demo" }, { kind: "priority", value: 3 }, { kind: "due", date: "2026-11-05" },
      { kind: "label", names: ["bug", "ui"] }, { kind: "unlabel", names: ["old"] }, { kind: "move", column: "In progress" },
    ]);
  });

  it("accepts the short forms and reports mistakes in words, without guessing", () => {
    expect(parseQuickActions("/assign me").ops).toEqual([{ kind: "assign", login: "me" }]);
    expect(parseQuickActions("/priority 0").ops).toEqual([{ kind: "priority", value: 0 }]);
    expect(parseQuickActions("/due none").ops).toEqual([{ kind: "due", date: null }]);
    expect(parseQuickActions("/unassign").ops).toEqual([{ kind: "unassign" }]);
    for (const bad of ["/assign not a user!", "/priority urgentest", "/due tomorrow", "/due 2026-13-45", "/label", "/move", "/nuke everything"]) expect(parseQuickActions(bad).errors).toHaveLength(1);
    expect(parseQuickActions("/nuke").ops).toEqual([]);
    expect(parseQuickActions(Array.from({ length: 13 }, () => "/unassign").join(NL)).errors[0]).toMatch(/At most 12/);
  });
});

describe("quick actions on a task", () => {
  it("previews in words, applies together as local changes, and refuses anything it cannot do", async () => {
    const { db, admin, ids } = S;
    const t = await createTask(db, admin, { projectId: ids.projects.atlas.id, title: "Plain task", labels: "a, b" });
    const text = ["/assign @bram-demo", "/priority urgent", "/due 2026-12-01", "/label c", "/unlabel a", "/move in-progress"].join(NL);
    const p = await previewQuick(db, admin, { type: "task", id: t.id }, text);
    expect(p.canApply).toBe(true);
    expect(p.lines.every((l) => l.writesTo === "dashboard")).toBe(true);
    expect(p.lines.map((l) => l.text)).toEqual(["Assign to @bram-demo", "Set the priority to urgent", "Set the due date to 2026-12-01", "Add the label c", "Remove the label a", "Move to “In progress”"]);
    expect((await getTask(db, admin, t.id)).task.priority).toBe(0); // previewing changed nothing
    expect(await applyQuick({ db, v: admin }, { type: "task", id: t.id }, text)).toEqual({ applied: 6, writesTo: "dashboard" });
    const after = (await getTask(db, admin, t.id)).task;
    expect(after).toMatchObject({ assigneeLogin: "bram-demo", priority: 4, labels: ["b", "c"] });
    expect(after.column.key).toBe("in-progress");
    expect(after.dueDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
    const bad = await previewQuick(db, admin, { type: "task", id: t.id }, "/move nowhere");
    expect(bad.canApply).toBe(false);
    expect(bad.lines[0].problem).toMatch(/No column called/);
    await expect(applyQuick({ db, v: admin }, { type: "task", id: t.id }, "/move nowhere")).rejects.toThrow(/No column/);
    await expect(applyQuick({ db, v: admin }, { type: "task", id: t.id }, "/priority nope")).rejects.toThrow(/\/priority takes/);
  });

  it("does not reach a task the person cannot see", async () => {
    const { db, b, ids } = S;
    await expect(previewQuick(db, b, { type: "task", id: ids.cards.cApiPr.id }, "/priority high")).rejects.toThrow();
  });
});

describe("quick actions on a GitHub item", () => {
  it("says it writes to GitHub, uses the same write path and authorization as the buttons, and leaves board-only commands out", async () => {
    const { db, admin, ids } = S;
    const id = ids.items.web9.id;
    const p = await previewQuick(db, admin, { type: "work", id }, ["/label needs-docs", "/assign me"].join(NL));
    expect(p.lines.map((l) => [l.writesTo, l.ok])).toEqual([["github", true], ["github", true]]);
    expect(p.lines[0].text).toMatch(/pull request #9/);
    const board = await previewQuick(db, admin, { type: "work", id }, "/priority high");
    expect(board.canApply).toBe(false);
    expect(board.lines[0].problem).toMatch(/belong to a task/);
    const fake = new FakeGithub();
    const r = await applyQuick({ db, v: admin, port: fake }, { type: "work", id }, ["/label needs-docs", "/assign me"].join(NL));
    expect(r.writesTo).toBe("github");
    expect(fake.writes.some((w) => w.startsWith("labels ") && w.includes("needs-docs"))).toBe(true);
    expect(fake.writes.some((w) => w.startsWith("assignees "))).toBe(true);
  });

  it("is refused for a viewer without a grant that includes managing work", async () => {
    const { db, b, ids } = S;
    await expect(previewQuick(db, b, { type: "work", id: ids.items.api14.id }, "/label x")).rejects.toThrow();
  });
});
