import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("markdown images", () => {
  it("renders GitHub-hosted images as images", () => {
    for (const src of [
      "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666",
      "https://github.com/acme/app/assets/12345/abcdef",
      "https://user-images.githubusercontent.com/1/2.png",
      "https://private-user-images.githubusercontent.com/1/2.png?jwt=x",
      "https://raw.githubusercontent.com/acme/app/main/x.png",
    ]) {
      const html = renderMarkdown(`![shot](${src})`);
      expect(html, src).toContain("<img");
      expect(html, src).toContain('alt="shot"');
    }
  });

  it("turns any other https image into a link, never an <img>", () => {
    const html = renderMarkdown("![pixel](https://evil.example/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://evil.example/pixel.png"');
    expect(html).toContain("Image: evil.example");
    expect(html).toContain('title="pixel"');
  });

  it("raw <img> html in the body is treated the same way", () => {
    const html = renderMarkdown('<img src="https://evil.example/p.gif" alt="x" onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("Image: evil.example");
  });

  it("does not trust lookalike hosts or non-attachment github.com paths", () => {
    for (const src of [
      "https://github.com.evil.example/user-attachments/assets/x",
      "https://evilgithubusercontent.com/x.png",
      "https://githubusercontent.com.evil.example/x.png",
      "https://user@raw.githubusercontent.com@evil.example/x.png",
      "https://github.com/some/page.png",
      "http://user-images.githubusercontent.com/1/2.png",
    ]) expect(renderMarkdown(`![a](${src})`), src).not.toContain("<img");
  });

  it("keeps data: and javascript: images out entirely", () => {
    const data = renderMarkdown("![d](data:image/png;base64,AAAA)");
    expect(data).not.toContain("<img");
    expect(data).not.toContain("data:");
    const js = renderMarkdown("![j](javascript:alert(1)) <script>alert(1)</script> [x](javascript:alert(2))");
    expect(js).not.toContain("<img");
    expect(js).not.toContain("<script");
    expect(js).not.toContain("javascript:");
  });
});
