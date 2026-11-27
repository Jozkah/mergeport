/**
 * Mentions while writing GitHub text: `@login` for a person, `#123` for an issue or pull request of the same repository.
 * Pure helpers (no React, no database) shared by the textarea popup, the suggestion service and the renderer.
 */

export type MentionKind = "user" | "item";
export type MentionTrigger = { kind: MentionKind; query: string; /** Index of the `@` or `#`. */ start: number };

export type UserSuggestion = { kind: "user"; login: string; avatar: string | null };
export type ItemSuggestion = { kind: "item"; number: number; title: string; type: "ISSUE" | "PULL_REQUEST"; state: "OPEN" | "CLOSED" | "MERGED"; href: string };
export type MentionSuggestion = UserSuggestion | ItemSuggestion;

export const MENTION_LIMIT = 8;
/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
export const LOGIN_QUERY = /^[A-Za-z0-9-]{0,39}$/;

/**
 * The mention being typed at the caret, or null. The marker must start the text or follow whitespace or `(`, so an email address
 * (`a@b.c`) or `foo#1` does not open the popup, and at least one character must follow it (a bare `#` at a line start is a heading).
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])([@#])([A-Za-z0-9-]{1,39}|[^\s@#]{1,50})$/.exec(before);
  if (!m) return null;
  const kind: MentionKind = m[2] === "@" ? "user" : "item";
  const query = m[3];
  if (kind === "user" && !LOGIN_QUERY.test(query)) return null;
  return { kind, query, start: before.length - query.length - 1 };
}

/** Replaces the marker and query (from `start` to the caret) with `token` and one space; returns the new text and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, token: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const insert = rest.startsWith(" ") ? token : `${token} `;
  const next = text.slice(0, start) + insert + rest;
  return { text: next, caret: start + insert.length + (rest.startsWith(" ") ? 1 : 0) };
}

export const mentionToken = (s: MentionSuggestion) => (s.kind === "user" ? `@${s.login}` : `#${s.number}`);

/** Issue and pull request numbers written as `#123` in some texts (deduplicated, at most `max`). Used to resolve links in one query. */
export function referencedNumbers(texts: (string | null | undefined)[], max = 200): number[] {
  const out = new Set<number>();
  for (const t of texts) {
    for (const m of (t ?? "").matchAll(/(?:^|[^\w&#/])#(\d{1,9})(?!\w)/g)) {
      out.add(Number(m[1]));
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}
