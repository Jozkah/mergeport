import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import light from "shiki/themes/github-light-default.mjs";
import dark from "shiki/themes/github-dark-default.mjs";
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import go from "shiki/langs/go.mjs";
import graphql from "shiki/langs/graphql.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import lua from "shiki/langs/lua.mjs";
import makefile from "shiki/langs/makefile.mjs";
import markdown from "shiki/langs/markdown.mjs";
import php from "shiki/langs/php.mjs";
import powershell from "shiki/langs/powershell.mjs";
import prisma from "shiki/langs/prisma.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import scss from "shiki/langs/scss.mjs";
import sql from "shiki/langs/sql.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";

/**
 * Syntax highlighting with the same Primer colours GitHub uses, in a light and a dark variant at once. Every token carries both
 * colours as CSS variables, so switching theme needs no re-render. It runs on the server, synchronously, with a fixed set of
 * grammars; anything else is shown as plain text, which is also what happens past the size limits.
 */

type G = typeof globalThis & { __mpHl?: ReturnType<typeof create> };
function create() {
  return createHighlighterCoreSync({
    themes: [light, dark],
    langs: [bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, html, ini, java, javascript, json, jsonc, jsx, kotlin, lua, makefile, markdown, php, powershell, prisma, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, xml, yaml].flat(),
    engine: createJavaScriptRegexEngine(),
  });
}
const hl = () => ((globalThis as G).__mpHl ??= create());

const EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "markdown", markdown: "markdown", css: "css", scss: "scss", html: "html", htm: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml", csproj: "xml", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", env: "ini",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", cs: "csharp", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  php: "php", lua: "lua", sql: "sql", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell", graphql: "graphql", gql: "graphql", prisma: "prisma",
  diff: "diff", patch: "diff", mk: "makefile",
};
const NAMES: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", py: "python", rb: "ruby", rs: "rust", md: "markdown", cs: "csharp", "c++": "cpp", ps1: "powershell", console: "bash", text: "", txt: "", plain: "" };

/** The grammar for a file path, or null when it should be shown as plain text. */
export function langForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (/^dockerfile(\..+)?$/i.test(name)) return "dockerfile";
  if (/^makefile$/i.test(name)) return "makefile";
  if (name.startsWith(".") && !name.includes(".", 1)) return /(ignore|attributes)$/.test(name) ? null : name === ".env" ? "ini" : null;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT[ext] ?? null;
}

/** A fence name ("ts", "jsonc", "shell") to a loaded grammar, or null. */
export function langForFence(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  const mapped = n in NAMES ? NAMES[n] : n;
  if (!mapped) return null;
  return hl().getLoadedLanguages().includes(mapped) ? mapped : null;
}

export const MAX_HIGHLIGHT_CHARS = 250_000;

/** A palette entry is "light|dark" hex colours; a token is [text, paletteIndex] with -1 meaning the default colour. */
export type Tok = [string, number];
export type Highlighted = { lines: Tok[][]; palette: string[] };

/** Tokens per line. Returns plain tokens (index -1) when the language is unknown or the text is too large. */
export function highlightLines(code: string, lang: string | null): Highlighted {
  const text = code.replace(/\r\n?/g, "\n");
  const rows = text.split("\n");
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS || rows.length > 8000) return { lines: rows.map((r) => [[r, -1]] as Tok[]), palette: [] };
  try {
    const { tokens } = hl().codeToTokens(text, { lang, themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false });
    const palette: string[] = [];
    const index = new Map<string, number>();
    const lines = tokens.map((line) =>
      line.map((t): Tok => {
        const v = t.htmlStyle as Record<string, string> | undefined;
        const l = v?.["--shiki-light"];
        const d = v?.["--shiki-dark"];
        if (!l && !d) return [t.content, -1];
        const key = `${l ?? ""}|${d ?? ""}`;
        let i = index.get(key);
        if (i === undefined) {
          i = palette.length;
          palette.push(key);
          index.set(key, i);
        }
        return [t.content, i];
      }),
    );
    return { lines, palette };
  } catch {
    return { lines: rows.map((r) => [[r, -1]] as Tok[]), palette: [] };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The inner HTML of a highlighted block: spans with colour variables, one per token, lines joined by newlines. */
export function highlightToHtml(code: string, lang: string | null): string {
  const { lines, palette } = highlightLines(code.replace(/\n$/, ""), lang);
  return lines
    .map((line) =>
      line
        .map(([text, i]) => {
          if (i < 0) return esc(text);
          const [l, d] = palette[i].split("|");
          return `<span style="${l ? `--l:${l};` : ""}${d ? `--d:${d}` : ""}">${esc(text)}</span>`;
        })
        .join(""),
    )
    .join("\n");
}
