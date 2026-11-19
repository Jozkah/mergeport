// Starts the Mergeport MCP server from any folder:  node <path to this file>
// MCP apps launch servers from their own working directory, so this runs the real server (scripts/mcp.ts) from the repository root.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["--import", "tsx", path.join("scripts", "mcp.ts")], { cwd: root, stdio: "inherit", windowsHide: true });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
