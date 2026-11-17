import { spawn } from "node:child_process";
import fs from "node:fs";
import { windowsNodeTool } from "@/lib/domain/upstream-update";
import { killTree, needsShell } from "@/lib/github/exec";
import { assertInside } from "@/lib/local/git-write";

/**
 * Runs the per-fork verify command inside the updater's private clone. The command comes from the local database only.
 *  - argv array, `shell: false`: the text was split by `splitCommand`, nothing is interpreted;
 *  - cwd must resolve inside the updater folder;
 *  - environment: PATH, SYSTEMROOT, HOME/USERPROFILE and CI=1, nothing else (no token, no GH_*, no Mergeport variable);
 *  - a time limit that kills the whole process tree, and a cap on what is written to the log (the process is still drained).
 */

export type VerifyResult = { code: number | null; timedOut: boolean; logTruncated: boolean; tail: string; startError: string | null; durationMs: number };

const TAIL_CHARS = 8000;
export const DEFAULT_LOG_BYTES = 2 * 1024 * 1024;

export function verifyEnv(): NodeJS.ProcessEnv {
  const e: Record<string, string> = { CI: "1" };
  for (const k of ["PATH", "SYSTEMROOT", "HOME", "USERPROFILE"] as const) if (process.env[k] !== undefined) e[k] = process.env[k]!;
  return e as unknown as NodeJS.ProcessEnv;
}

export async function runVerify(o: { argv: string[]; cwd: string; root: string; timeoutMs: number; logFile: string; maxLogBytes?: number; nodeExe?: string; exists?: (p: string) => boolean; now?: () => number }): Promise<VerifyResult> {
  const t0 = (o.now ?? Date.now)();
  const done = (r: Partial<VerifyResult>): VerifyResult => ({ code: null, timedOut: false, logTruncated: false, tail: "", startError: null, ...r, durationMs: (o.now ?? Date.now)() - t0 });
  await assertInside(o.root, o.cwd);
  let argv = o.argv;
  if (process.platform === "win32") argv = windowsNodeTool(argv, o.nodeExe ?? process.execPath, o.exists ?? fs.existsSync) ?? argv;
  if (!argv[0]) return done({ startError: "No command to run" });
  if (needsShell(argv[0])) return done({ startError: `${argv[0]} is a .cmd/.bat script, which cannot be started without a shell. Use a program, or "node script.js".` });

  return new Promise<VerifyResult>((resolve) => {
    const cap = o.maxLogBytes ?? DEFAULT_LOG_BYTES;
    const log = fs.createWriteStream(o.logFile, { flags: "a" });
    log.on("error", () => {});
    let written = 0;
    let truncated = false;
    let tail = "";
    let timedOut = false;
    let settled = false;
    const take = (b: Buffer) => {
      tail = (tail + b.toString("utf8")).slice(-TAIL_CHARS);
      if (written >= cap) return void (truncated = true);
      const room = cap - written;
      log.write(b.length > room ? b.subarray(0, room) : b);
      written += Math.min(b.length, room);
      if (b.length > room) truncated = true;
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(/* turbopackIgnore: true */ argv[0], argv.slice(1), { cwd: o.cwd, shell: false, windowsHide: true, env: verifyEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log.end();
      return resolve(done({ startError: `Could not start the command: ${(e as Error).message}` }));
    }
    const finish = (r: Partial<VerifyResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end(truncated ? "\n[log cut: size limit reached]\n" : "\n");
      resolve(done({ tail, logTruncated: truncated, timedOut, ...r }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish({ code: null }), 5000).unref(); // a grandchild holding the pipes open must not hold the run
    }, o.timeoutMs);
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (e) => finish({ startError: (e as NodeJS.ErrnoException).code === "ENOENT" ? `The program "${argv[0]}" was not found.${process.platform === "win32" ? " Tools installed as .cmd shims (pnpm, yarn) cannot run without a shell; use an .exe or node script.js." : ""}` : `Could not start the command: ${e.message}` }));
    child.on("close", (code) => finish({ code }));
  });
}
