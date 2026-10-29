import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/** GitHub Markdown -> sanitized HTML. Raw HTML from the source is untrusted and filtered by allow-list. */
export function renderMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  const html = marked.parse(src, { gfm: true, async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "img", "details", "summary", "input", "span"],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title"], input: ["type", "checked", "disabled"], th: ["align"], td: ["align"], code: ["class"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
      input: (tag, attribs) => ({ tagName: tag, attribs: { type: "checkbox", disabled: "disabled", ...(attribs.checked !== undefined ? { checked: "checked" } : {}) } }),
    },
    disallowedTagsMode: "discard",
  });
}
