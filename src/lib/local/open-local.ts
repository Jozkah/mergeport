import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Opens a folder in the file manager or the editor on THIS computer. The caller must already have checked that the path is one of
 * the person's own recorded worktrees. Arguments are passed as an array (no shell), and nothing is written.
 */
export function openLocal(path: string, how: "folder" | "editor"): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!fs.existsSync(path)) return Promise.resolve({ ok: false, error: "That folder no longer exists on this computer." });
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const [cmd, args] = how === "editor" ? (win ? ["cmd.exe", ["/c", "code", path]] : ["code", [path]]) : win ? ["explorer.exe", [path]] : mac ? ["open", [path]] : ["xdg-open", [path]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], { shell: false, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve({ ok: false, error: how === "editor" ? "Could not start the editor. Is the `code` command installed?" : "Could not open the folder." }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch {
      resolve({ ok: false, error: "Could not start the program." });
    }
  });
}
