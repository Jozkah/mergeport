import fs from "node:fs";
import path from "node:path";

/**
 * Best-effort static scan for tenancy (see docs/tenancy.md): every call of a Prisma delegate of a ROOT model (a model with a
 * `workspaceId` column) must mention a workspace scope somewhere in its arguments, unless the file is on the allowlist
 * (src/lib/authz/tenancy-allowlist.ts). Regex + balanced-parenthesis scan, no type information: cheap, and it catches the obvious
 * case (a query on a ROOT model with no workspace filter). Known blind spots are listed in docs/tenancy.md.
 */

export const OPS = [
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "update", "updateMany", "upsert", "delete", "deleteMany", "create", "createMany", "createManyAndReturn",
] as const;

/** Tokens that count as "scoped": a literal workspaceId, or one of the shared helpers that put it in the filter. */
export const SCOPE_TOKENS = ["workspaceId", "repoWhere(", "projectWhere(", "wsScope(", "tenantWhere("];

export type Violation = { file: string; line: number; model: string; op: string; snippet: string };

/** Models that carry a workspaceId column, read from the Prisma schema (so a new ROOT model is covered automatically). */
export function rootModels(root: string): string[] {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const out: string[] = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+workspaceId\s/m.test(m[2])) out.push(m[1]);
  }
  return out;
}

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

/** Text of the call's argument list starting at the "(" at `open` (balanced, string- and template-aware enough for this code base). */
export function argsAt(src: string, open: number): string {
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

export function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "generated" || e.name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ["src", "scripts"]) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  const seed = path.join(root, "prisma", "seed.ts");
  if (fs.existsSync(seed)) out.push(seed);
  return out;
}

/** Calls of firstWorkspace( (the fail-closed "the profile's one workspace" lookup): repository-relative file -> line numbers. */
export function firstWorkspaceCalls(root: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const file of listSources(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (/\bfirstWorkspace\(/.test(l) && !/function firstWorkspace\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) out.set(rel, [...(out.get(rel) ?? []), i + 1]);
      });
  }
  return out;
}

export function scan(root: string, models: string[] = rootModels(root)): Violation[] {
  const delegates = new Set(models.map(lowerFirst));
  const re = new RegExp(`\\.(${[...delegates].join("|")})\\.(${OPS.join("|")})\\s*(?:<[^>(]*>)?\\(`, "g");
  const found: Violation[] = [];
  for (const file of listSources(root)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const open = m.index! + m[0].length - 1;
      const args = argsAt(src, open);
      if (SCOPE_TOKENS.some((t) => args.includes(t))) continue;
      const line = src.slice(0, m.index).split("\n").length;
      found.push({ file: path.relative(root, file).split(path.sep).join("/"), line, model: m[1], op: m[2], snippet: args.replace(/\s+/g, " ").slice(0, 110) });
    }
  }
  return found;
}
