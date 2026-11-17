/**
 * Upstream auto-updater: the pure parts (command splitting, setting validation, pull request text, outcome rules).
 * Nothing here touches git, the disk or the network, so every rule is tested directly.
 */

/** Older upstream commits tried below a head that conflicts or fails verification, before waiting for the next head. */
export const MAX_BACK = 6;
/** Commits kept in a run's review list. */
export const MAX_COMMITS = 50;
export const DEFAULT_BRANCH = "mergeport/upstream-sync";
export const DEFAULT_TIMEOUT_SEC = 20 * 60;
export const MIN_TIMEOUT_SEC = 10;
export const MAX_TIMEOUT_SEC = 2 * 60 * 60;
export const LOG_TAIL_CHARS = 4000;

export type UpdateState = "running" | "promoted" | "pr-opened" | "up-to-date" | "conflict" | "verify-failed" | "failed" | "cancelled" | "merged-untested";
export type PromoteMode = "pr" | "push";

/** Outcomes that mean the person has something to look at: they create a notification and appear in `upstreamUpdateAttention`. */
export const NOTABLE: readonly UpdateState[] = ["pr-opened", "merged-untested", "promoted", "conflict", "verify-failed", "failed"];
/** The subset that still needs the person (a promoted push is news, not a to-do). */
export const NEEDS_PERSON: readonly UpdateState[] = ["pr-opened", "merged-untested", "conflict", "verify-failed", "failed"];

export type CommitInfo = { sha: string; subject: string; author: string; url: string };

export class CommandError extends Error {}

const MAX_COMMAND_CHARS = 2000;
const MAX_ARGS = 64;

/**
 * Splits a command line into an argument array. Quote-aware and nothing else: single quotes are literal, double quotes are literal
 * except `\"`, a backslash elsewhere is an ordinary character (Windows paths). There is NO expansion of any kind: `;`, `|`, `&`,
 * `>`, `<`, `$`, `*`, `~`, backticks and parentheses are plain characters of an argument. The result is only ever run with
 * `shell: false`, so none of them is interpreted by anything.
 */
export function splitCommand(input: string): string[] {
  if (input.length > MAX_COMMAND_CHARS) throw new CommandError("The command is too long");
  if (input.includes("\0")) throw new CommandError("The command contains a null character");
  const out: string[] = [];
  let cur = "";
  let has = false; // a token exists even when empty ("")
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && input[i + 1] === '"') {
        cur += '"';
        i++;
      } else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new CommandError("The command has an unclosed quote");
  if (has || cur) out.push(cur);
  if (out.length > MAX_ARGS) throw new CommandError(`The command has more than ${MAX_ARGS} parts`);
  return out;
}

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
export const branchNameOk = (b: string) => BRANCH.test(b) && !b.includes("..") && !b.includes("//") && !b.endsWith("/") && !b.endsWith(".lock") && !b.endsWith(".");

export type ConfigInput = { enabled: boolean; verifyCommand: string | null; promote: PromoteMode; timeoutSec: number; branchName: string };

/** Validates and normalises what the Forks page sends. Throws CommandError with a message a person can act on. */
export function cleanConfig(raw: { enabled?: unknown; verifyCommand?: unknown; promote?: unknown; timeoutSec?: unknown; branchName?: unknown }, mapping: { forkBranch: string; upstreamBranch: string }): ConfigInput {
  const verify = typeof raw.verifyCommand === "string" ? raw.verifyCommand.trim() : "";
  if (verify) {
    const argv = splitCommand(verify);
    if (argv.length === 0 || !argv[0]) throw new CommandError("Enter a program to run");
  }
  const promote: PromoteMode = raw.promote === "push" ? "push" : "pr";
  if (promote === "push" && !verify) throw new CommandError("Pushing straight to the fork branch needs a verify command. Without one, only a pull request can be opened.");
  const secs = Number(raw.timeoutSec);
  const timeoutSec = Number.isFinite(secs) ? Math.round(secs) : DEFAULT_TIMEOUT_SEC;
  if (timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) throw new CommandError(`The time limit must be between ${MIN_TIMEOUT_SEC} seconds and ${MAX_TIMEOUT_SEC / 3600} hours`);
  const branchName = (typeof raw.branchName === "string" && raw.branchName.trim()) || DEFAULT_BRANCH;
  if (!branchNameOk(branchName)) throw new CommandError("That is not a usable branch name");
  if (branchName === mapping.forkBranch || branchName === mapping.upstreamBranch) throw new CommandError("The sync branch must be a different branch from the fork and upstream branches");
  return { enabled: raw.enabled === true || raw.enabled === "on" || raw.enabled === "true", verifyCommand: verify || null, promote, timeoutSec, branchName };
}

/** Subject lines are untrusted text that ends up in a pull request: shown as code so nothing is mentioned, linked or rendered. */
const inert = (s: string) => s.replace(/[`\r\n]+/g, " ").trim().slice(0, 200);

export function pullRequestText(i: { upstream: string; upstreamBranch: string; forkBranch: string; sha: string; verify: "passed" | "untested"; commits: CommitInfo[]; totalCommits: number; tried: string[] }): { title: string; body: string } {
  const lines = i.commits.map((c) => `- [\`${c.sha.slice(0, 7)}\`](${c.url}) \`${inert(c.subject)}\` by \`${inert(c.author)}\``);
  const more = i.totalCommits > i.commits.length ? [`- and ${i.totalCommits - i.commits.length} more`] : [];
  const skipped = i.tried.length > 1 ? [`Newer upstream commits (${i.tried.slice(0, -1).map((s) => `\`${s.slice(0, 7)}\``).join(", ")}) conflicted or failed verification, so this is the newest one that worked.`, ""] : [];
  return {
    title: `Merge ${i.upstream}@${i.sha.slice(0, 7)} into ${i.forkBranch}`,
    body: [
      `Mergeport merged \`${i.upstream}:${i.upstreamBranch}\` at \`${i.sha.slice(0, 7)}\` into \`${i.forkBranch}\` in a private clone on the maintainer's computer.`,
      "",
      i.verify === "passed" ? "The verify command passed on the merged result." : "**Not tested:** no verify command is configured for this fork, so nothing ran on the merged result.",
      "",
      ...skipped,
      `Upstream commits merged (${i.totalCommits}):`,
      ...lines,
      ...more,
      "",
      "This branch is rewritten by Mergeport on every update. Review it like any other pull request; Mergeport never merges it.",
    ].join("\n"),
  };
}

/** What the failures of every candidate add up to, newest first: all conflicts is `conflict`, anything that failed verification is `verify-failed`. */
export function exhaustedState(outcomes: ("conflict" | "verify-failed" | "error")[]): "conflict" | "verify-failed" | "failed" {
  if (outcomes.length === 0) return "failed";
  if (outcomes.includes("verify-failed")) return "verify-failed";
  if (outcomes.every((o) => o === "conflict")) return "conflict";
  return "failed";
}

/** The `npm`/`npx` of a Windows install are .cmd shims, which cannot be started without a shell. Maps them to the real script beside node.exe. */
export function windowsNodeTool(argv: string[], nodeExe: string, exists: (p: string) => boolean): string[] | null {
  const tool = argv[0]?.toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (tool !== "npm" && tool !== "npx") return null;
  const dir = nodeExe.replace(/[\\/][^\\/]*$/, "");
  const script = `${dir}\\node_modules\\npm\\bin\\${tool}-cli.js`;
  return exists(script) ? [nodeExe, script, ...argv.slice(1)] : null;
}
