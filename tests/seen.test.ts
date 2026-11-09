import { beforeEach, describe, expect, it } from "vitest";
import { changesSince, takeSnapshot } from "@/lib/domain/changes";
import { markSeen, sinceLastLooked } from "@/lib/services/seen";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const base = { state: "OPEN", headSha: "h1", checksState: "SUCCESS", mergeable: "MERGEABLE", title: "T" };
const c = (kind: string, author: string, at: number, reviewState: string | null = null) => ({ kind, authorLogin: author, createdAtGh: new Date(at), reviewState });

describe("changes since last looked (pure)", () => {
  it("has no baseline on the first look, so nothing is reported as new", () => {
    expect(changesSince(null, takeSnapshot({ ...base, comments: [] }, "me"))).toEqual([]);
  });

  it("reports new commits, comments from others (not mine), reviewer decisions, checks and conflicts", () => {
    const before = takeSnapshot({ ...base, comments: [c("ISSUE_COMMENT", "x", 1)] }, "me");
    const after = takeSnapshot({
      ...base, headSha: "h2", checksState: "FAILURE", mergeable: "CONFLICTING",
      comments: [c("ISSUE_COMMENT", "x", 1), c("ISSUE_COMMENT", "y", 5), c("ISSUE_COMMENT", "me", 6), c("REVIEW", "Rev", 7, "APPROVED")],
    }, "me");
    const text = changesSince(before, after).map((x) => x.text);
    expect(text).toEqual(expect.arrayContaining(["New commits were pushed", "1 new comment from others", "rev approved", "Checks are now failing", "It now conflicts with the base branch"]));
    expect(changesSince(before, before)).toEqual([]);
  });

  it("reports a decision change and a dismissed review", () => {
    const a = takeSnapshot({ ...base, comments: [c("REVIEW", "r", 1, "APPROVED")] }, "me");
    const b = takeSnapshot({ ...base, comments: [c("REVIEW", "r", 1, "APPROVED"), c("REVIEW", "r", 2, "CHANGES_REQUESTED")] }, "me");
    const d = takeSnapshot({ ...base, comments: [c("REVIEW", "r", 1, "APPROVED"), c("REVIEW", "r", 2, "DISMISSED")] }, "me");
    expect(changesSince(a, b).map((x) => x.text)).toEqual(["r requested changes"]);
    expect(changesSince(a, d).map((x) => x.text)).toEqual(["r's review was dismissed"]);
  });
});

describe("since last looked (service)", () => {
  it("records a baseline silently, lists changes until acknowledged, and is personal", async () => {
    const { db, a, b, ids } = S;
    const id = ids.items.web9.id;
    expect((await sinceLastLooked(db, a, id)).changes).toEqual([]); // baseline
    await db.workItem.update({ where: { id }, data: { headSha: "f".repeat(40), checksState: "FAILURE" } });
    const first = await sinceLastLooked(db, a, id);
    expect(first.changes.map((x) => x.kind)).toEqual(expect.arrayContaining(["commits", "checks"]));
    expect((await sinceLastLooked(db, a, id)).changes.length).toBe(first.changes.length); // viewing does not dismiss
    await markSeen(db, a, id);
    expect((await sinceLastLooked(db, a, id)).changes).toEqual([]);
    expect((await sinceLastLooked(db, b, id)).changes).toEqual([]); // someone else's first look is their own baseline
  });

  it("refuses an item the viewer cannot see", async () => {
    const { db, b, ids } = S;
    await expect(sinceLastLooked(db, b, ids.items.api14.id)).rejects.toThrow();
  });
});
