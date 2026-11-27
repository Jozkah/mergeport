import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

/** GitHub renders issue and comment bodies with hard line breaks; README and other .md files keep CommonMark's soft breaks. */
describe("markdown line breaks", () => {
  it("keeps single newlines in issue and comment bodies", () => {
    const html = renderMarkdown("first line\nsecond line", { breaks: true });
    expect(html).toMatch(/first line<br \/>\s*second line/);
  });

  it("leaves files (README, .md) with soft breaks by default", () => {
    const html = renderMarkdown("first line\nsecond line");
    expect(html).not.toContain("<br");
  });

  it("still splits paragraphs on a blank line", () => {
    expect(renderMarkdown("a\n\nb", { breaks: true })).toBe("<p>a</p>\n<p>b</p>\n");
  });
});
