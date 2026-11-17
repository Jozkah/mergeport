import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill } from "@/lib/cli/skill-install";

const source = path.resolve(import.meta.dirname, "..", "docs", "agent-skill", "mergeport");
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-skill-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const by = (r: ReturnType<typeof installSkill>) => Object.fromEntries(r.map((x) => [x.tool, x.action]));
const skillAt = (dir: string) => path.join(home, dir, "skills", "mergeport", "SKILL.md");

describe("the shipped skill", () => {
  it("has the frontmatter an agent needs and stays short", () => {
    const md = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
    expect(md).toMatch(/^---\nname: mergeport\ndescription: .{100,}\n---\n/);
    for (const phrase of ["add this to mergeport", "assign", "under <repo> repo", "mergeport board", "mergeport todo", "label it bug", "In progress"]) expect(md.toLowerCase()).toContain(phrase.toLowerCase());
    expect(md.split("\n").length).toBeLessThanOrEqual(120);
    expect(md).toContain("MERGEPORT_DIR");
  });
});

describe("installSkill", () => {
  it("creates ~/.claude and ~/.agents, and skips tool folders that are absent", () => {
    const r = installSkill({ home, source });
    expect(by(r)).toEqual({ claude: "created", codex: "skipped", agents: "created", gemini: "skipped" });
    expect(fs.readFileSync(skillAt(".claude"), "utf8")).toBe(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"));
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".gemini"))).toBe(false);
  });

  it("installs for codex and gemini when their folders exist, and when asked for by name", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    expect(by(installSkill({ home, source }))).toMatchObject({ codex: "created", gemini: "skipped" });
    expect(by(installSkill({ home, source, tools: ["gemini"] }))).toEqual({ claude: "skipped", codex: "skipped", agents: "skipped", gemini: "created" });
    expect(fs.existsSync(skillAt(".gemini"))).toBe(true);
  });

  it("is idempotent", () => {
    installSkill({ home, source });
    expect(by(installSkill({ home, source }))).toMatchObject({ claude: "unchanged", agents: "unchanged" });
  });

  it("refuses to overwrite a differing file without --force, then overwrites with it", () => {
    installSkill({ home, source });
    fs.writeFileSync(skillAt(".claude"), "my own edits");
    const r = installSkill({ home, source });
    expect(by(r)).toMatchObject({ claude: "refused", agents: "unchanged" });
    expect(fs.readFileSync(skillAt(".claude"), "utf8")).toBe("my own edits");
    expect(by(installSkill({ home, source, force: true }))).toMatchObject({ claude: "updated" });
    expect(fs.readFileSync(skillAt(".claude"), "utf8")).toBe(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"));
  });

  it("--dry-run reports but writes nothing", () => {
    const r = installSkill({ home, source, dryRun: true });
    expect(by(r)).toMatchObject({ claude: "created", agents: "created" });
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
