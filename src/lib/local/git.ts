import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseStatus, parseWorktreeList } from "@/lib/domain/gitparse";

/**
 * Read-only git access for the connector.
 *  - argument arrays only, `shell: false`: nothing is ever interpolated into a command line;
 *  - a fixed allow-list of git subcommands, none of which write;
 *  - bounded time and output;
 *  - a scrubbed environment so GIT_DIR / GIT_WORK_TREE from the shell cannot redirect it.
 */

const ALLOWED = new Set(["rev-parse", "worktree", "status"]);
const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 2 * 1024 * 1024;

export class GitError extends Error {}

export function runGit(cwd: string, args: string[]): Promise<string> {
  if (!ALLOWED.has(args[0])) return Promise.reject(new GitError(`git ${args[0]} is not permitted in the connector`));
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(new GitError(`git ${args[0]} failed`));
      else resolve(stdout);
    });
  });
}

/** A root must be an absolute path to an existing directory that is the top level of a git repository. */
export async function validateRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new GitError("Use an absolute path");
  let real: string;
  try {
    real = await fs.realpath(input);
  } catch {
    throw new GitError("That path does not exist");
  }
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new GitError("That path is not a directory");
  if (path.parse(real).root === real) throw new GitError("A filesystem root cannot be a repository root");
  const top = (await runGit(real, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!top) throw new GitError("That folder is not a git repository");
  const realTop = await fs.realpath(top).catch(() => top);
  if (path.resolve(realTop).toLowerCase() !== path.resolve(real).toLowerCase()) throw new GitError("Choose the top-level folder of the repository");
  return real;
}

export type Snapshot = {
  capturedAt: string;
  worktrees: {
    path: string;
    branch: string | null;
    head: string | null;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
    missing?: boolean;
    dirty?: { staged: number; unstaged: number; untracked: number; conflicted: number };
    tracking?: { upstream: string | null; ahead: number | null; behind: number | null };
  }[];
};

/** Counts and names of refs only. File names, diffs and file contents are never read or sent. */
export async function collectSnapshot(root: string, now = new Date()): Promise<Snapshot> {
  const list = parseWorktreeList(await runGit(root, ["worktree", "list", "--porcelain", "-z"]));
  const worktrees: Snapshot["worktrees"] = [];
  for (const w of list) {
    if (w.bare) continue;
    const base = { path: w.path, branch: w.branch, head: w.head, detached: w.detached, locked: w.locked, prunable: w.prunable };
    const exists = await fs.stat(w.path).then((s) => s.isDirectory(), () => false);
    if (!exists) {
      worktrees.push({ ...base, missing: true });
      continue;
    }
    try {
      const st = parseStatus(await runGit(w.path, ["status", "--porcelain=v1", "-z", "--branch"]));
      worktrees.push({ ...base, dirty: { staged: st.staged, unstaged: st.unstaged, untracked: st.untracked, conflicted: st.conflicted }, tracking: { upstream: st.upstream, ahead: st.ahead, behind: st.behind } });
    } catch {
      worktrees.push(base); // status unavailable: report what the list knows, do not guess
    }
  }
  return { capturedAt: now.toISOString(), worktrees };
}
