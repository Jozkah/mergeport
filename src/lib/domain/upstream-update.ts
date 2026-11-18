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

export type UpdateState = "running" | "promoted" | "pr-opened" | "up-to-date" | "conflict" | "verify-failed" | "failed" | "cancelled" | "merged-untested" | "release-found";
export type PromoteMode = "pr" | "push";
/** `merge`: merge upstream commits in a private clone. `releases`: only read the upstream's releases and warn (no git, no verify, no PR). */
export type UpdateMode = "merge" | "releases";

/** Release watch limits. One check per mapping per ~15 minutes (a hair under, so the 15-minute reconcile cycle is never skipped by jitter). */
export const RELEASE_CHECK_MIN_MS = 14 * 60_000;
/** Warnings made by one check; the rest is counted in a "+N more" note. */
export const RELEASE_MAX_PER_CHECK = 5;
export const RELEASE_NOTES_CHARS = 600;
/** A release warning stays under "needs me" in the digest until it was looked at, or this many days. */
export const RELEASE_ATTENTION_DAYS = 14;

/** Outcomes that mean the person has something to look at: they create a notification and appear in `upstreamUpdateAttention`. */
export const NOTABLE: readonly UpdateState[] = ["pr-opened", "merged-untested", "promoted", "conflict", "verify-failed", "failed"];
/** The subset that still needs the person (a promoted push is news, not a to-do). */
export const NEEDS_PERSON: readonly UpdateState[] = ["pr-opened", "merged-untested", "conflict", "verify-failed", "failed"];

export type CommitInfo = { sha: string; subject: string; author: string; url: string };

/** What a `release-found` run stores about the release. All text is untrusted: it is only ever rendered as text. */
export type ReleaseInfo = {
  id: string;
  tag: string;
  name: string | null;
  url: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  notes: string;
  /** Does the fork's branch already contain the tag? null: not known (nothing is guessed). */
  inFork: boolean | null;
  /** Releases the same check found beyond the cap. */
  more: number;
};

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

/**
 * The default sync branch for a mapping, given the branches other enabled configs of the SAME fork already use: two mappings sharing one
 * branch would each force-push over the other's pull request head. The first mapping keeps the plain default; another one gets the
 * upstream branch as a suffix (and a number if even that is taken).
 */
export function defaultSyncBranch(upstreamBranch: string, taken: readonly string[]): string {
  if (!taken.includes(DEFAULT_BRANCH)) return DEFAULT_BRANCH;
  const slug = upstreamBranch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "upstream";
  const base = `${DEFAULT_BRANCH}-${slug}`.replace(/\.lock$/, "");
  for (let n = 1; ; n++) {
    const b = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(b) && branchNameOk(b)) return b;
  }
}

export type ConfigInput ={ enabled: boolean; verifyCommand: string | null; promote: PromoteMode; timeoutSec: number; branchName: string };

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

/** What the Forks page saves: `merge` carries the merge settings, `releases` carries none (stored merge settings are left as they are). */
export type SettingsInput = ({ mode: "merge" } & ConfigInput) | { mode: "releases"; enabled: boolean };

const on = (v: unknown) => v === true || v === "on" || v === "true";

/**
 * Mode-aware validation. In `releases` mode nothing about git is used, so the verify command, promote mode, time limit and branch name
 * are neither required nor looked at (a half-edited command cannot block saving a release watch). `push` still needs a verify command
 * in `merge` mode. `includePrereleases` is null when the caller did not say (keep what is stored).
 */
export function cleanSettings(raw: { mode?: unknown; enabled?: unknown; verifyCommand?: unknown; promote?: unknown; timeoutSec?: unknown; branchName?: unknown; includePrereleases?: unknown }, mapping: { forkBranch: string; upstreamBranch: string }): SettingsInput & { includePrereleases: boolean | null } {
  const includePrereleases = raw.includePrereleases === undefined ? null : on(raw.includePrereleases);
  if (raw.mode === "releases") return { mode: "releases", enabled: on(raw.enabled), includePrereleases };
  return { mode: "merge", ...cleanConfig(raw, mapping), includePrereleases };
}

/** Release notes are untrusted text: control characters out, runs of blank lines collapsed, cut at `max` characters. Plain text, never HTML. */
export function plainExcerpt(text: string | null | undefined, max = RELEASE_NOTES_CHARS): string {
  const t = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** A release link is only kept when it is http(s) and points into the UPSTREAM repository on the configured host. */
export function safeReleaseUrl(url: string | null | undefined, upstreamFullName: string, host = "github.com"): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname.toLowerCase() !== host.toLowerCase() || u.username || u.password) return null;
    return u.pathname.toLowerCase().startsWith(`/${upstreamFullName.toLowerCase()}/`) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Which releases to warn about. Drafts are never considered; prereleases only with the option. New = published after the cursor and not
 * warned before; the newest `cap` are kept (oldest first) and the rest counted. `newest` is the new cursor.
 */
export function pickNewReleases<R extends { id: string; draft: boolean; prerelease: boolean; publishedAt: Date | null }>(
  releases: R[],
  o: { after: Date | null; warned: ReadonlySet<string>; includePrereleases: boolean; cap?: number },
): { fresh: R[]; more: number; newest: R | null } {
  const usable = releases.filter((r) => !r.draft && r.publishedAt && (o.includePrereleases || !r.prerelease)).sort((a, b) => a.publishedAt!.getTime() - b.publishedAt!.getTime());
  const unseen = usable.filter((r) => (!o.after || r.publishedAt! > o.after) && !o.warned.has(r.id));
  const cap = o.cap ?? RELEASE_MAX_PER_CHECK;
  return { fresh: unseen.slice(-cap), more: Math.max(0, unseen.length - cap), newest: usable.at(-1) ?? null };
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
