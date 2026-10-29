import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for the motion system (docs/motion.md). They read source text only; the behaviour itself was checked in a browser.

const root = path.resolve(import.meta.dirname, "..", "src");
const css = readFileSync(path.join(root, "app", "motion.css"), "utf8");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("motion guards", () => {
  it("never uses transition: all or a blanket will-change", () => {
    const hits: string[] = [];
    for (const f of sources(root)) {
      const text = readFileSync(f, "utf8");
      if (/transition\s*:\s*all\b|transition-all\b|will-change/.test(text)) hits.push(path.relative(root, f));
    }
    expect(hits).toEqual([]);
  });

  it("declares durations, easings and distances only through tokens outside :root", () => {
    const body = css.replace(/:root\s*\{[\s\S]*?\n\}/g, "").replace(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g, "");
    const bad = body
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*(animation|transition)(-duration|-timing-function)?\s*:/.test(line) && /(\d(\.\d+)?m?s\b|cubic-bezier\()/.test(line.replace(/var\([^)]*\)/g, "").replace(/calc\([^)]*\)/g, "")));
    expect(bad.map((b) => `${b.n}: ${b.line.trim()}`)).toEqual([]);
  });

  it("collapses movement tokens under prefers-reduced-motion", () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const t of ["--distance-micro: 0px", "--distance-base: 0px", "--distance-large: 0px", "--scale-large: 1", "--scale-tiny: 1", "--blur-small: 0px", "--blur-medium: 0px"]) expect(block).toContain(t);
    for (const d of ["--duration-fast", "--duration-slow", "--duration-very-slow"]) expect(block).toMatch(new RegExp(`${d}:\\s*\\d+ms`));
  });

  it("defines no class that is also a Tailwind utility (a `.collapse` rule once made open menus invisible: visibility: collapse)", () => {
    const utilities = new Set(["collapse", "visible", "invisible", "block", "inline", "hidden", "static", "fixed", "absolute", "relative", "sticky", "flex", "grid", "table", "contents", "container", "truncate", "underline", "ring", "outline", "shadow", "border", "filter", "transition", "transform", "resize", "isolate", "grow", "shrink", "italic", "uppercase", "lowercase", "capitalize"]);
    const classes = [...css.matchAll(/(?:^|[\s,}>+~])\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]);
    expect(classes.filter((c) => utilities.has(c))).toEqual([]);
  });

  it("keeps every named keyframe in use", () => {
    const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const all = sources(root).map((f) => readFileSync(f, "utf8")).join("\n");
    const unused = names.filter((n) => !new RegExp(`animation\\s*:[^;]*\\b${n}\\b|\\banimate-${n}\\b|animation-name\\s*:\\s*${n}\\b`).test(all) && !all.includes(`"${n}"`));
    expect(unused).toEqual([]);
  });

  it("lets only the board glide with GSAP, and only on the inner wrapper", () => {
    const users = sources(root).filter((f) => /from "gsap"/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).replaceAll("\\", "/"));
    expect(users).toEqual(["components/planning/Board.tsx"]);
    const board = readFileSync(path.join(root, "components", "planning", "Board.tsx"), "utf8");
    expect(board).toMatch(/gsap\.fromTo\(inner,/);
    expect(board).not.toMatch(/gsap\.(to|fromTo|set)\(li\b/);
  });
});
