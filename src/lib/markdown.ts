import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { highlightToHtml, langForFence } from "@/lib/highlight";

const decode = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Fenced blocks with a known language get GitHub's colours. The text is decoded from the sanitized HTML and escaped again by the highlighter. */
function highlightFences(html: string): string {
  return html.replace(/<pre><code(?: class="language-([\w+#.-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (whole, lang: string | undefined, body: string) => {
    const l = langForFence(lang);
    if (!l) return whole;
    return `<pre class="hl"><code class="language-${l}">${highlightToHtml(decode(body), l)}</code></pre>`;
  });
}

/**
 * Only images GitHub itself serves are loaded: user-attachments / repo asset paths on github.com and *.githubusercontent.com
 * (user-images, private-user-images, raw, camo, avatars ...). Any other host would make the owner's browser contact a stranger
 * the moment a page renders (tracking pixel: IP + time), so those become a plain link. Keep in step with img-src in csp.ts.
 */
export function isGithubImage(u: URL): boolean {
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".githubusercontent.com")) return true;
  return host === "github.com" && /^\/(user-attachments\/|[^/]+\/[^/]+\/(assets|raw)\/)/.test(u.pathname);
}

function imageTag(_tag: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const alt = attribs.alt ?? "";
  let url: URL | null = null;
  try {
    url = new URL(attribs.src ?? "");
  } catch {
    url = null;
  }
  if (url && isGithubImage(url)) return { tagName: "img", attribs: { src: attribs.src, alt, ...(attribs.title ? { title: attribs.title } : {}) } };
  // Not a GitHub image: a link the person can choose to open. Other schemes (data:, javascript:) get no link at all.
  if (url && (url.protocol === "https:" || url.protocol === "http:")) {
    return { tagName: "a", text: `Image: ${url.host}`, attribs: { href: attribs.src, title: alt || (attribs.title ?? "") } };
  }
  return { tagName: "span", text: alt ? `Image: ${alt}` : "Image", attribs: {} };
}

/** How `#123` is linked in GitHub text: the Mergeport page of an item known here (`items`), else the issue on GitHub under `repoUrl`. */
export type MentionRefs = { repoUrl: string; items: Map<number, string> };

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const EXT = 'rel="noopener noreferrer nofollow" target="_blank"';
const LINKING_TAG = /^<(\/?)(a|code|pre)(?=[\s>])/i;

/**
 * Links `@login` to the GitHub profile and (with `refs`) `#123` to the item, in text only: never inside a tag, a link, inline code
 * or a code block. Runs on the sanitized HTML, so text is already escaped; a marker must not follow a word character, `&` (entities
 * such as `&#39;`), `/` or another marker, which keeps emails, URLs and `org/team` alone. Logins and numbers need no escaping.
 */
function linkMentions(html: string, refs: MentionRefs | undefined): string {
  const repoUrl = refs && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(refs.repoUrl.replace(/\/+$/, "")) ? refs.repoUrl.replace(/\/+$/, "") : null;
  let inside = 0; // depth of a / code / pre
  return html.replace(/(<[^>]*>)|([^<]+)/g, (whole, tag: string | undefined, text: string | undefined) => {
    if (tag) {
      const m = LINKING_TAG.exec(tag);
      if (m) inside = Math.max(0, inside + (m[1] ? -1 : 1));
      return whole;
    }
    if (inside > 0 || !text) return whole;
    return text.replace(/(^|[^\w&/@#])(?:@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\w/-])|#(\d{1,9})(?![\w]))/g, (all, pre: string, login: string | undefined, num: string | undefined) => {
      if (login) return `${pre}<a href="https://github.com/${login}" ${EXT}>@${login}</a>`;
      if (!repoUrl || !num) return all;
      const n = Number(num);
      const local = refs?.items.get(n);
      if (local && /^\/(issues|pull-requests)\/[\w-]+$/.test(local)) return `${pre}<a href="${escAttr(local)}">#${num}</a>`;
      return `${pre}<a href="${escAttr(`${repoUrl}/issues/${n}`)}" ${EXT}>#${num}</a>`;
    });
  });
}

/**
 * GitHub Markdown -> sanitized HTML. Raw HTML from the source is untrusted and filtered by allow-list.
 * `breaks`: a single newline is a line break, as GitHub shows issue, pull request and comment bodies. Files (README, .md) leave it off.
 */
export function renderMarkdown(src: string | null | undefined, o: { breaks?: boolean; refs?: MentionRefs } = {}): string {
  if (!src) return "";
  const html = marked.parse(src, { gfm: true, breaks: o.breaks ?? false, async: false }) as string;
  const clean = sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "img", "details", "summary", "input", "span"],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title"], input: ["type", "checked", "disabled"], th: ["align"], td: ["align"], code: ["class"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    transformTags: {
      img: imageTag,
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
      input: (tag, attribs) => ({ tagName: tag, attribs: { type: "checkbox", disabled: "disabled", ...(attribs.checked !== undefined ? { checked: "checked" } : {}) } }),
    },
    disallowedTagsMode: "discard",
  });
  // GitHub text (issue, pull request and comment bodies) gets mention links; files do not.
  return highlightFences(o.breaks ? linkMentions(clean, o.refs) : clean);
}
