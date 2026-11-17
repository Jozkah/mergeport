/**
 * Installs the Mergeport agent skill (docs/agent-skill/mergeport) for the AI tools on this computer.
 *   npm run skill:install [-- --dry-run] [-- --force] [-- --tool claude,codex,agents,gemini]
 * Only copies files into ~/.claude, ~/.codex, ~/.agents or ~/.gemini `skills/mergeport`. Touches nothing else.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs, flagBool, flagStr, UsageError } from "../src/lib/cli/argv";
import { installSkill, TOOLS, type ToolId } from "../src/lib/cli/skill-install";

try {
  const p = parseArgs(process.argv.slice(2), { "dry-run": { kind: "bool" }, force: { kind: "bool" }, tool: { kind: "value" } }, 0);
  const tools = flagStr(p, "tool")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const bad = tools.find((t) => !TOOLS.some((x) => x.id === t));
  if (bad) throw new UsageError(`Unknown tool "${bad}". Use ${TOOLS.map((t) => t.id).join(", ")}`);
  const dryRun = flagBool(p, "dry-run");
  const results = installSkill({ home: os.homedir(), source: path.resolve(__dirname, "..","docs", "agent-skill", "mergeport"), force: flagBool(p, "force"), dryRun, tools: tools as ToolId[] });
  for (const r of results) console.log(`${r.tool.padEnd(7)} ${dryRun && (r.action === "created" || r.action === "updated") ? "would be " : ""}${r.action}  ${r.target}${r.reason ? `  (${r.reason})` : ""}`);
  if (results.some((r) => r.action === "refused")) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = e instanceof UsageError ? 2 : 1;
}
