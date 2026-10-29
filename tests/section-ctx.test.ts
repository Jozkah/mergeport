import { describe, expect, it } from "vitest";
import { ctx } from "@/lib/ctx";
import { sectionFor } from "@/lib/section";

describe("sections and context entries", () => {
  it("gives every route one section", () => {
    expect(["/", "/attention?queue=waiting", "/tasks/abc", "/pull-requests/1", "/issues", "/planning", "/repositories/x/code", "/forks", "/admin/rules", "/settings", "/search"].map(sectionFor)).toEqual(["overview", "attention", "tasks", "work", "work", "planning", "source", "source", "team", "team", "overview"]);
  });
  it("drops falsy entries and keeps separators", () => {
    expect(JSON.parse(ctx([{ label: "A", copy: "x" }, false, "sep", null, { label: "B", href: "/b" }]))).toEqual([{ label: "A", copy: "x" }, "sep", { label: "B", href: "/b" }]);
  });
});
