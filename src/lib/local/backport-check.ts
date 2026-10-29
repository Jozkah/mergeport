import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Verified local evidence that an upstream change is already on a branch of a local clone. Read-only.
 *  - ancestry: the upstream commit is an ancestor of the branch (git merge-base --is-ancestor);
 *  - patch-equivalent: a commit on the branch makes the same change (same added and removed lines, ignoring line numbers and
 *    whitespace), which is what a cherry-pick or rebase leaves behind. It is "possible equivalence", never proof;
 *  - not-found: the clone has the upstream commit and neither of the above holds;
 *  - not-checked: the clone cannot answer (the commit is not fetched, or history was too large to scan).
 * Titles and pull request numbers are never evidence. Diffs are hashed in memory and never stored or returned.
 */
export type BackportCheck = { result: "ancestor" | "patch-equivalent" | "not-found" | "not-checked"; localSha?: string; reason: string };

const ALLOWED = new Set(["cat-file", "merge-base", "log", "show"]);
const SHA = /^[0-9a-f]{7,40}$/i;
const REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const SCAN_COMMITS = 400;

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<{ code: number; stdout: string }> {
  if (!ALLOWED.has(args[0])) return Promise.reject(new Error(`git ${args[0]} is not permitted here`));
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { shell: false, timeout: 30_000, maxBuffer, env, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === "number") return resolve({ code, stdout: stdout ?? "" });
      reject(new Error("git could not run"));
    });
  });
}

/** A signature of what a patch does: its added and removed lines, whitespace-normalised, without headers or line numbers. */
export function patchSignature(diff: string): string | null {
  const lines = diff.split(/\r?\n/).filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")));
  if (lines.length === 0) return null;
  return createHash("sha1").update(lines.map((l) => l[0] + l.slice(1).replace(/\s+/g, " ").trim()).join("\n")).digest("hex");
}

export async function checkBackport(root: string, upstreamSha: string, branch: string): Promise<BackportCheck> {
  if (!SHA.test(upstreamSha)) return { result: "not-checked", reason: "That is not a commit id" };
  if (!REF.test(branch) || branch.includes("..")) return { result: "not-checked", reason: "That is not a branch name" };
  try {
    if ((await git(root, ["cat-file", "-e", `${upstreamSha}^{commit}`])).code !== 0) return { result: "not-checked", reason: "The upstream commit is not in your local clone. Fetch the upstream remote, then check again." };
    if ((await git(root, ["cat-file", "-e", `refs/heads/${branch}^{commit}`])).code !== 0 && (await git(root, ["cat-file", "-e", `${branch}^{commit}`])).code !== 0) return { result: "not-checked", reason: `Your clone has no branch called ${branch}` };
    const anc = await git(root, ["merge-base", "--is-ancestor", upstreamSha, branch]);
    if (anc.code === 0) return { result: "ancestor", reason: "The upstream commit is an ancestor of this branch." };

    const show = await git(root, ["show", "-m", "--first-parent", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", upstreamSha]);
    const want = show.code === 0 ? patchSignature(show.stdout) : null;
    if (!want) return { result: "not-checked", reason: "The upstream commit changes no lines that can be compared." };
    const log = await git(root, ["log", "--no-merges", "--no-color", "--no-ext-diff", "--no-textconv", "-p", `-n${SCAN_COMMITS}`, "--format=@@@%H", branch]);
    if (log.code !== 0) return { result: "not-checked", reason: "The branch history could not be read." };
    for (const block of log.stdout.split(/^@@@/m)) {
      const nl = block.indexOf("\n");
      if (nl < 0) continue;
      const sha = block.slice(0, nl).trim();
      if (SHA.test(sha) && patchSignature(block.slice(nl + 1)) === want) return { result: "patch-equivalent", localSha: sha, reason: `Commit ${sha.slice(0, 7)} on ${branch} makes the same change. That suggests a cherry-pick or rebase, which is possible equivalence rather than proof.` };
    }
    return { result: "not-found", reason: `No commit among the last ${SCAN_COMMITS} on ${branch} makes this change, and it is not an ancestor. That does not prove it is absent: it may have been rewritten.` };
  } catch (e) {
    return { result: "not-checked", reason: e instanceof Error && /buffer/i.test(e.message) ? "The history was too large to scan." : "Git could not answer." };
  }
}
