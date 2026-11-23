import { describe, expect, it } from "vitest";
import { cleanQuery, deleteView, listViews, saveView, setViewShared, viewHref } from "@/lib/services/views";
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
