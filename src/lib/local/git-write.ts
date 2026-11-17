import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The ONLY place Mergeport lets git write, and only inside the upstream auto-updater's private folder
 * (`<MERGEPORT_HOME>/updater/<mappingId>/`). `git.ts` stays read-only and is deliberately not loosened.
 *  - argument arrays only, `shell: false`: nothing is ever interpolated into a command line;
 *  - a fixed allow-list of subcommands, each with its own argument rules (no deleting, no forced or broad pushes, no options that run programs);
 *  - `cwd` must resolve (realpath) inside the updater folder, so a link or `..` cannot lead into anyone's working tree;
 *  - a scrubbed environment (no GIT_DIR / GIT_WORK_TREE, never a prompt), a timeout and an output cap on every call;
 *  - credentials only through the GitHub CLI's credential helper, bound to the profile's account, so Mergeport never reads, stores or logs a token;
 *  - URL credentials are redacted from everything that is returned, thrown or logged.
 */

export class GitWriteError extends Error {
  constructor(
    message: string,
    readonly code: "refused" | "outside" | "timeout" | "output" | "spawn",
  ) {
    super(message);
  }
}

export const WRITE_ALLOWED = new Set(["clone", "fetch", "checkout", "switch", "reset", "merge", "merge-base", "rev-list", "log", "rev-parse", "status", "push", "branch", "remote", "config", "diff"]);
const REMOTE_OPS = new Set(["clone", "fetch", "push"]);
const REMOTES = new Set(["origin", "upstream"]);
/** Options that run a program, write a file somewhere, or move the git directory. Refused for every subcommand. */
const DENIED_OPTION = /^(--upload-pack|--receive-pack|--exec|--config|--template|--separate-git-dir|--git-dir|--work-tree|--output|--ext-diff|--textconv|--open-files-in-pager|--recurse-submodules)/;
/** Keys the updater may set in its private clone. Anything else (aliases, hooks, ssh commands, credential helpers) is refused. */
const CONFIG_KEYS = new Set(["user.name", "user.email", "commit.gpgsign", "core.longpaths", "core.autocrlf", "gc.auto"]);

export const DEFAULT_TIMEOUT_MS = 120_000;
export const NETWORK_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export type GitResult = { stdout: string; stderr: string; code: number };

export type GitWriterOptions = {
  /** The updater folder of ONE mapping. Every cwd must resolve inside it. */
  root: string;
  /** Full destination refs a push may update (e.g. `refs/heads/mergeport/upstream-sync`). Nothing else can be pushed to. */
  pushRefs: string[];
  /** `-c credential.helper=<value>` for clone, fetch and push. Null (tests, file URLs): no helper at all. */
  credentialHelper?: string | null;
  /** Extra environment for network calls (GH_HOST, the CLI's config location). Never a token. */
  remoteEnv?: Record<string, string>;
  /** Runs before every network call; throws to block it (the profile's account is not the one the CLI would use). */
  beforeRemote?: () => Promise<void>;
  log?: (line: string) => void;
};

/** `https://user:secret@host/x` becomes `https://***@host/x`. Applied to every string that leaves this module. */
export const redactUrls = (s: string) => s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1***@");

/** True when `target` is `root` or lies inside it, after resolving links on both. Both must exist. */
export async function isInside(root: string, target: string): Promise<boolean> {
  let r: string;
  let t: string;
  try {
    [r, t] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  } catch {
    return false;
  }
  const win = process.platform === "win32";
  const rel = path.relative(win ? r.toLowerCase() : r, win ? t.toLowerCase() : t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function assertInside(root: string, cwd: string): Promise<void> {
  if (!(await isInside(root, cwd))) throw new GitWriteError("git was asked to work outside the updater folder", "outside");
}

function checkArgs(args: string[], o: GitWriterOptions): void {
  const sub = args[0];
  if (!sub || !WRITE_ALLOWED.has(sub)) throw new GitWriteError(`git ${sub ?? ""} is not permitted for the updater`, "refused");
  const rest = args.slice(1);
  for (const a of rest) {
    if (typeof a !== "string" || a.includes("\0")) throw new GitWriteError("Bad git argument", "refused");
    if (DENIED_OPTION.test(a)) throw new GitWriteError(`git ${sub} ${a.split("=")[0]} is not permitted for the updater`, "refused");
  }
  if ((sub === "clone" || sub === "fetch") && rest.includes("-u")) throw new GitWriteError("-u is not permitted", "refused");
  if (sub === "diff" && !rest.includes("--name-only")) throw new GitWriteError("git diff is only allowed with --name-only", "refused");
  if (sub === "branch" && rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|--force|-f)$/.test(a) || /^-[a-zA-Z]*[dDmM]/.test(a))) throw new GitWriteError("git branch may not delete or rename branches", "refused");
  if (sub === "config") {
    const keys = rest.filter((a) => !a.startsWith("-"));
    const mode = rest.filter((a) => a.startsWith("-"));
    if (mode.some((a) => !/^(--local|--get|--bool)$/.test(a))) throw new GitWriteError("git config option not permitted", "refused");
    if (!keys[0] || !CONFIG_KEYS.has(keys[0])) throw new GitWriteError(`git config ${keys[0] ?? ""} is not permitted`, "refused");
    if (keys.length > 2) throw new GitWriteError("git config takes a key and a value", "refused");
  }
  if (sub === "remote") {
    const verb = rest[0];
    if (!verb || !/^(add|set-url|get-url)$/.test(verb)) throw new GitWriteError("git remote may only add, set-url or get-url", "refused");
    if (!REMOTES.has(rest[1] ?? "")) throw new GitWriteError("Only the remotes origin and upstream exist", "refused");
    if ((rest[2] ?? "").startsWith("-")) throw new GitWriteError("Bad remote URL", "refused");
  }
  if (sub === "clone") {
    const dest = rest[rest.length - 1];
    if (rest.length < 2 || !dest || /[\\/]|^\.\.?$|^-/.test(dest)) throw new GitWriteError("clone needs a URL and a plain folder name inside the updater folder", "refused");
    if ((rest[rest.length - 2] ?? "").startsWith("-") || /^(ext|fd)::/.test(rest[rest.length - 2])) throw new GitWriteError("Bad clone URL", "refused");
  }
  if (sub === "push") {
    // Exactly one remote (origin, never upstream) and one explicit `refs/heads/X:refs/heads/Y` whose destination is on the allow-list.
    const flags = rest.filter((a) => a.startsWith("-"));
    const pos = rest.filter((a) => !a.startsWith("-"));
    for (const f of flags) {
      if (!/^(--force-with-lease=refs\/heads\/[^\s:]+:[0-9a-f]{0,64}|--porcelain|--no-tags|--atomic|--no-recurse-submodules)$/.test(f)) throw new GitWriteError(`git push ${f.split("=")[0]} is not permitted (no force, delete, mirror, all or tags)`, "refused");
    }
    if (pos.length !== 2 || pos[0] !== "origin") throw new GitWriteError("git push must name the remote origin and one refspec", "refused");
    const m = /^(refs\/heads\/[^\s:+]+):(refs\/heads\/[^\s:+]+)$/.exec(pos[1]);
    if (!m) throw new GitWriteError("git push needs an explicit refs/heads/X:refs/heads/Y refspec (no delete, no force prefix)", "refused");
    if (!o.pushRefs.includes(m[2])) throw new GitWriteError(`git push may not update ${m[2]}`, "refused");
  }
}

/** The environment of a git call: nothing inherited except what finding git and the home folder need. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra } as unknown as NodeJS.ProcessEnv;
}

export type GitWriter = {
  /** Runs git and returns its output and exit code (a non-zero exit is a result, not an exception). */
  run(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<GitResult>;
  /** Like run, but a non-zero exit throws with git's (redacted) message. Returns stdout. */
  ok(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<string>;
};

export function createGitWriter(o: GitWriterOptions): GitWriter {
  const run: GitWriter["run"] = async (cwd, args, opts = {}) => {
    checkArgs(args, o);
    await assertInside(o.root, cwd);
    const remote = REMOTE_OPS.has(args[0]);
    if (remote) await o.beforeRemote?.();
    const global = ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "-c", "commit.gpgsign=false", ...(remote ? ["-c", "credential.helper=", ...(o.credentialHelper ? ["-c", `credential.helper=${o.credentialHelper}`] : [])] : [])];
    o.log?.(redactUrls(`$ git ${args.join(" ")}`));
    const timeoutMs = opts.timeoutMs ?? (remote ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    return new Promise<GitResult>((resolve, reject) => {
      execFile("git", [...global, ...args], { cwd, shell: false, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: gitEnv(remote ? (o.remoteEnv ?? {}) : {}), windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        const out = redactUrls(String(stdout ?? ""));
        const errText = redactUrls(String(stderr ?? ""));
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new GitWriteError(`git ${args[0]} produced too much output`, "output"));
          if (e.killed) return reject(new GitWriteError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`, "timeout"));
          if (typeof e.code === "string") return reject(new GitWriteError(`git could not be started (${e.code})`, "spawn"));
          o.log?.(errText.trim());
          return resolve({ stdout: out, stderr: errText, code: typeof e.code === "number" ? e.code : 1 });
        }
        resolve({ stdout: out, stderr: errText, code: 0 });
      });
    });
  };
  return {
    run,
    async ok(cwd, args, opts) {
      const r = await run(cwd, args, opts);
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400)}`);
      return r.stdout;
    },
  };
}
