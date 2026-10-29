import { describe, expect, it } from "vitest";
import { buildDiffFile, parsePatch, toSplitRows } from "@/lib/diff";
import { DEMO_CHANGES, makePatch } from "@/lib/demo/repo-files";
import { highlightToHtml, langForFence, langForPath } from "@/lib/highlight";
import { renderMarkdown } from "@/lib/markdown";

const PATCH = ["@@ -1,4 +1,5 @@ function a()", " keep", "-old one", "-old two", "+new one", "+new two", "+new three", " tail", "\\ No newline at end of file"].join("\n");

describe("parsing a GitHub patch", () => {
  it("numbers old and new lines separately and keeps the section name", () => {
    const [h] = parsePatch(PATCH);
    expect(h).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, section: "function a()" });
    expect(h.lines.map((l) => l.t)).toEqual(["ctx", "del", "del", "add", "add", "add", "ctx"]);
    expect(h.lines[6].nonl).toBe(true);
  });

  it("builds rows whose numbers follow both files", () => {
    const f = buildDiffFile({ filename: "a.ts", status: "modified", additions: 3, deletions: 2, patch: PATCH });
    const rows = f.hunks[0].lines.map((l) => [l.t, l.o, l.n]);
    expect(rows).toEqual([["ctx", 1, 1], ["del", 2, null], ["del", 3, null], ["add", null, 2], ["add", null, 3], ["add", null, 4], ["ctx", 4, 5]]);
  });

  it("pairs removals with the additions after them in split view", () => {
    const f = buildDiffFile({ filename: "a.ts", status: "modified", additions: 3, deletions: 2, patch: PATCH });
    const rows = toSplitRows(f.hunks[0].lines);
    expect(rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null])).toEqual([[1, 1], [2, 2], [3, 3], [null, 4], [4, 5]]);
  });

  it("reports a file without a patch instead of inventing one", () => {
    expect(buildDiffFile({ filename: "logo.png", status: "added", additions: 0, deletions: 0, patch: null }).state).toBe("nopatch");
  });

  it("agrees with the generated demo diffs: every hunk's counts match its lines", () => {
    for (const c of DEMO_CHANGES) {
      const d = makePatch(c.before, c.after);
      const f = buildDiffFile({ filename: c.filename, status: "modified", additions: d.additions, deletions: d.deletions, patch: d.patch });
      for (const h of f.hunks) {
        expect(h.lines.filter((l) => l.t !== "add").length).toBe(h.oldLines);
        expect(h.lines.filter((l) => l.t !== "del").length).toBe(h.newLines);
      }
      expect(f.hunks.flatMap((h) => h.lines).filter((l) => l.t === "add").length).toBe(d.additions);
    }
  });

  it("highlights both sides and escapes what it prints", () => {
    const f = buildDiffFile({ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = '<b>';" });
    expect(f.palette.length).toBeGreaterThan(0);
    expect(f.hunks[0].lines[1].tok.map((t) => t[0]).join("")).toBe("const a = '<b>';");
    const html = highlightToHtml("x = '<script>'", "typescript");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("languages", () => {
  it("maps paths and fence names, and leaves unknown ones plain", () => {
    expect(langForPath("src/a.tsx")).toBe("tsx");
    expect(langForPath("Dockerfile")).toBe("dockerfile");
    expect(langForPath("notes.unknown")).toBeNull();
    expect(langForFence("ts")).toBe("typescript");
    expect(langForFence("shell")).toBe("bash");
    expect(langForFence("nonsense")).toBeNull();
  });
});

describe("markdown code blocks", () => {
  it("colours fenced blocks with a known language and leaves the rest plain", () => {
    const html = renderMarkdown("```ts\nconst a = 1 < 2;\n```\n\n```nonsense\nplain <b>\n```");
    expect(html).toContain('class="hl"');
    expect(html).toContain("--l:");
    expect(html).toContain("&lt;</span>");
    expect(html).toMatch(/<pre><code class="language-nonsense">plain &lt;b&gt;/);
  });
  it("cannot be used to smuggle markup through a code block", () => {
    const html = renderMarkdown("```ts\n</code></pre><script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
  });
});
