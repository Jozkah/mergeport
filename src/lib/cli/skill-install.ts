import fs from "node:fs";
import path from "node:path";

/**
 * Copies the agent skill (docs/agent-skill/mergeport) into the standard global skills folders of the AI tools on this computer.
 * ~/.claude and ~/.agents are created when missing; ~/.codex and ~/.gemini only when the tool's own folder already exists
 * (or the tool is asked for by name). A file that already exists with different content is never overwritten without `force`.
 */
export const TOOLS = [
  { id: "claude", dir: ".claude", create: true },
  { id: "codex", dir: ".codex", create: false },
  { id: "agents", dir: ".agents", create: true },
  { id: "gemini", dir: ".gemini", create: false },
] as const;
export type ToolId = (typeof TOOLS)[number]["id"];

export type InstallAction = "created" | "updated" | "unchanged" | "skipped" | "refused";
export type InstallResult = { tool: ToolId; target: string; action: InstallAction; files: string[]; reason?: string };
export type InstallOpts = { home: string; source: string; force?: boolean; dryRun?: boolean; tools?: ToolId[] };

function listFiles(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
}

export function installSkill(o: InstallOpts): InstallResult[] {
  const files = listFiles(o.source);
  if (!files.includes("SKILL.md")) throw new Error(`${o.source} has no SKILL.md`);
  const requested = o.tools && o.tools.length ? new Set(o.tools) : null;
  const out: InstallResult[] = [];
  for (const t of TOOLS) {
    const target = path.join(o.home, t.dir, "skills", "mergeport");
    if (requested && !requested.has(t.id)) {
      out.push({ tool: t.id, target, action: "skipped", files: [], reason: "not requested" });
      continue;
    }
    if (!requested && !t.create && !fs.existsSync(path.join(o.home, t.dir))) {
      out.push({ tool: t.id, target, action: "skipped", files: [], reason: `${path.join(o.home, t.dir)} does not exist` });
      continue;
    }
    const state = files.map((f) => {
      const dest = path.join(target, f);
      if (!fs.existsSync(dest)) return { f, dest, kind: "new" as const };
      return { f, dest, kind: fs.readFileSync(dest).equals(fs.readFileSync(path.join(o.source, f))) ? ("same" as const) : ("differs" as const) };
    });
    const differs = state.filter((s) => s.kind === "differs");
    if (differs.length && !o.force) {
      out.push({ tool: t.id, target, action: "refused", files: differs.map((s) => s.dest), reason: "a different file is already there; use --force to overwrite" });
      continue;
    }
    const todo = state.filter((s) => s.kind !== "same");
    if (!todo.length) {
      out.push({ tool: t.id, target, action: "unchanged", files: [] });
      continue;
    }
    if (!o.dryRun) {
      for (const s of todo) {
        fs.mkdirSync(path.dirname(s.dest), { recursive: true });
        fs.copyFileSync(path.join(o.source, s.f), s.dest);
      }
    }
    out.push({ tool: t.id, target, action: differs.length ? "updated" : "created", files: todo.map((s) => s.dest) });
  }
  return out;
}
