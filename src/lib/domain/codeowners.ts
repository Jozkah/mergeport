/**
 * CODEOWNERS parsing and matching, following GitHub's documented rules. Pure.
 *
 * - The last matching pattern in the file wins; earlier ones are ignored for that path.
 * - Patterns use gitignore-like syntax: `*`, `**`, a leading `/` anchors to the root, a trailing `/` matches a directory.
 * - An owner is `@user`, `@org/team` or an email. A pattern with no owners clears ownership for what it matches.
 * - `[...]` character classes, `!` negation and `\\#` escapes are not supported by GitHub in CODEOWNERS; they are not interpreted here.
 *
 * Routing from CODEOWNERS is advice from the repository's own file. Whether GitHub *requires* a code owner review depends on branch
 * protection, which this module knows nothing about.
 */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

export type OwnerRule = { pattern: string; owners: string[]; line: number };
export type Owner = { raw: string; kind: "user" | "team" | "email"; ref: string };

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    rules.push({ pattern: parts[0], owners: parts.slice(1), line: i + 1 });
  });
  return rules;
}

export function parseOwner(raw: string): Owner | null {
  if (/^@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(raw)) return { raw, kind: "team", ref: raw.slice(1) };
  if (/^@[A-Za-z0-9-]+$/.test(raw)) return { raw, kind: "user", ref: raw.slice(1) };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { raw, kind: "email", ref: raw };
  return null;
}

/** gitignore-style pattern to a regular expression over repository-relative paths (no leading slash). */
export function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const hasSlash = p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" matches any number of directories (including none); a trailing "/**" matches everything below
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern with no slash matches at any depth; one with a slash (or a leading one) is relative to the root.
  const prefix = anchored || hasSlash ? "^" : "^(?:.*/)?";
  // A directory (or a name that is a directory) owns everything inside it.
  const tail = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(prefix + re + tail);
}

export function ownersFor(path: string, rules: OwnerRule[]): { owners: string[]; rule: OwnerRule | null } {
  let hit: OwnerRule | null = null;
  for (const r of rules) if (patternToRegExp(r.pattern).test(path)) hit = r;
  return { owners: hit?.owners ?? [], rule: hit };
}

export type RouteEntry = { owner: Owner; files: string[]; patterns: string[] };
export type Routing = {
  entries: RouteEntry[];
  /** Changed files that no CODEOWNERS rule claims. Not an error: GitHub does not require owners everywhere. */
  unowned: string[];
  /** Owner strings that are not a recognised user, team or email. They are listed, never guessed. */
  invalid: string[];
};

export function routeFiles(paths: string[], rules: OwnerRule[]): Routing {
  const byOwner = new Map<string, RouteEntry>();
  const unowned: string[] = [];
  const invalid = new Set<string>();
  for (const f of paths) {
    const { owners, rule } = ownersFor(f, rules);
    const parsed = owners.flatMap((o) => {
      const p = parseOwner(o);
      if (!p) invalid.add(o);
      return p ? [p] : [];
    });
    if (parsed.length === 0) {
      if (!rule || rule.owners.length === 0) unowned.push(f);
      continue;
    }
    for (const o of parsed) {
      const key = o.raw.toLowerCase();
      const e = byOwner.get(key) ?? { owner: o, files: [], patterns: [] };
      e.files.push(f);
      if (rule && !e.patterns.includes(rule.pattern)) e.patterns.push(rule.pattern);
      byOwner.set(key, e);
    }
  }
  return { entries: [...byOwner.values()].sort((a, b) => b.files.length - a.files.length || a.owner.raw.localeCompare(b.owner.raw)), unowned, invalid: [...invalid] };
}
