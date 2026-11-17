import fs from "node:fs";
import path from "node:path";
import type { UpstreamUpdateRun } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { LOG_TAIL_CHARS, MAX_BACK, MAX_COMMITS, NOTABLE, branchNameOk, exhaustedState, pullRequestText, splitCommand, type CommitInfo, type UpdateState } from "@/lib/domain/upstream-update";
import type { GithubPort } from "@/lib/github/port";
import { assertInside, createGitWriter, redactUrls, type GitWriter } from "@/lib/local/git-write";
import { runVerify } from "@/lib/local/verify-run";

/**
 * The upstream auto-updater's pipeline for ONE mapping, ported in idea (not code) from a server-side updater: take the newest upstream
 * commit, merge it onto our own branch, test the result, and only then promote it. A newer upstream head restarts the attempt, a commit
 * that conflicts or fails is skipped for the next older one (at most MAX_BACK), and everything notable is reported.
 *
 * It works ONLY in a Mergeport-owned clone under `<home>/updater/<mappingId>/repo`. It never reads, writes or runs anything in a
 * working tree of the person's. It never deletes a branch, never pushes to upstream, and pushes only the sync branch (pr mode) or, if the
 * person chose it AND a verify command passed, a plain fast-forward of the fork branch (push mode).
 */

export type Step = "fetched" | "merged" | "verified";

export type UpdaterDeps = {
  db: Db;
  /** The Mergeport home (contains `updater/`). */
  home: string;
  /** The acting person's GitHub port (opens the pull request). */
  port: () => Promise<GithubPort>;
  /** Where `role` lives. Production: https://<host>/<owner>/<repo>.git. Tests: a local bare repository. */
  remoteUrl: (role: "fork" | "upstream", fullName: string) => string;
  /** Host used for commit links in the review (github.com). */
  host?: string;
  credentialHelper?: string | null;
  remoteEnv?: Record<string, string>;
  beforeRemote?: () => Promise<void>;
  now?: () => Date;
  /** Stops the run between steps (shutdown). A running verify is never killed by it. */
  signal?: AbortSignal;
  /** Test seam: called after each step, before the "is there a newer upstream head?" check. */
  afterStep?: (step: Step, info: { sha: string; runId: string }) => Promise<void> | void;
  /** Largest log written to disk per run. */
  maxLogBytes?: number;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESTARTS = 3;
const LOG_FILE_CAP = 2 * 1024 * 1024;

export const updaterRoot = (home: string) => path.join(home, "updater");
export function updaterDir(home: string, mappingId: string): string {
  if (!ID.test(mappingId)) throw new Error("Bad mapping id");
  return path.join(updaterRoot(home), mappingId);
}

class Cancelled extends Error {}

type Candidate = { sha: string };
type Outcome = { state: UpdateState; error?: string; prUrl?: string | null; files?: string[]; sha?: string | null };

function makeLog(file: string, cap: number) {
  const lines: string[] = [];
  let bytes = 0;
  return {
    add(text: string) {
      for (const raw of redactUrls(text).split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        lines.push(line);
        if (bytes < cap) {
          bytes += line.length + 1;
          try {
            fs.appendFileSync(file, line + "\n");
          } catch {
            /* the log is a convenience; the run goes on */
          }
        }
      }
    },
    tail: () => lines.join("\n").slice(-LOG_TAIL_CHARS),
  };
}

export async function runUpdate(deps: UpdaterDeps, mappingId: string, opts: { manual?: boolean } = {}): Promise<UpstreamUpdateRun | null> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const m = await db.forkMapping.findUnique({ where: { id: mappingId }, include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } }, updateConfig: true } });
  if (!m || !m.updateConfig?.enabled || m.fork.isDemo) return null;
  const cfg = m.updateConfig;
  const dir = updaterDir(deps.home, mappingId);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  await assertInside(updaterRoot(deps.home), dir);

  const run = await db.upstreamUpdateRun.create({ data: { mappingId, trigger: opts.manual ? "manual" : "auto", startedAt: now(), triedShas: [], commits: [] } });
  const log = makeLog(path.join(dir, "logs", `${run.id}.log`), LOG_FILE_CAP);
  const tried: string[] = [];
  let upstreamSha: string | null = null;
  let forkSha: string | null = null;
  let commits: CommitInfo[] = [];
  let total = 0;
  let outcome: Outcome;
  try {
    outcome = await pipeline();
  } catch (e) {
    const msg = redactUrls(e instanceof Error ? e.message : String(e));
    outcome = e instanceof Cancelled ? { state: "cancelled", error: msg } : { state: "failed", error: msg };
    log.add(`${outcome.state}: ${msg}`);
  }

  // An up-to-date answer is recorded once per upstream commit; asking again and getting the same answer leaves no new row.
  if (outcome.state === "up-to-date") {
    const prev = await db.upstreamUpdateRun.findFirst({ where: { mappingId, id: { not: run.id }, finishedAt: { not: null } }, orderBy: { startedAt: "desc" } });
    if (prev && prev.state === "up-to-date" && prev.upstreamSha === upstreamSha) {
      await db.upstreamUpdateRun.delete({ where: { id: run.id } });
      await db.upstreamUpdateConfig.update({ where: { mappingId }, data: { lastRunAt: now() } });
      return null;
    }
  }
  const done = await db.upstreamUpdateRun.update({
    where: { id: run.id },
    data: { state: outcome.state, finishedAt: now(), upstreamSha, forkSha, triedShas: tried, prUrl: outcome.prUrl ?? null, filesConflicted: outcome.files ?? undefined, commits: commits as never, logTail: log.tail(), error: outcome.error ? redactUrls(outcome.error).slice(0, 1000) : null },
  });
  await db.upstreamUpdateConfig.update({ where: { mappingId }, data: { lastRunAt: now() } });
  if ((NOTABLE as readonly string[]).includes(done.state)) await notifyRun(db, { mappingId, forkRepoId: m.forkRepoId, workspaceId: m.fork.workspaceId, forkName: m.fork.fullName, state: done.state as UpdateState, prUrl: done.prUrl, error: done.error, sha: done.upstreamSha });
  return done;

  // ---------------------------------------------------------------------------------------------------------------

  async function pipeline(): Promise<Outcome> {
    const forkFull = m!.fork.fullName;
    const upFull = m!.upstream.fullName;
    const B = cfg.branchName;
    const forkBranch = m!.forkBranch;
    const upBranch = m!.upstreamBranch;
    if (!branchNameOk(B) || B === forkBranch || B === upBranch) return { state: "failed", error: "The sync branch name is not usable" };
    const mode = cfg.promote === "push" ? "push" : "pr";
    if (mode === "push" && !cfg.verifyCommand) return { state: "failed", error: "Push mode needs a verify command; refusing to push untested code" };
    let argv: string[] | null = null;
    if (cfg.verifyCommand) {
      argv = splitCommand(cfg.verifyCommand);
      if (!argv[0]) return { state: "failed", error: "The verify command is empty" };
    }

    const git: GitWriter = createGitWriter({ root: dir, pushRefs: [mode === "pr" ? `refs/heads/${B}` : `refs/heads/${forkBranch}`], credentialHelper: deps.credentialHelper ?? null, remoteEnv: deps.remoteEnv, beforeRemote: deps.beforeRemote, log: (l) => log.add(l) });
    const repo = path.join(dir, "repo");
    const cancelled = async () => {
      if (deps.signal?.aborted) throw new Cancelled("Stopped because Mergeport is closing");
      const c = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
      if (!c?.enabled) throw new Cancelled("Auto-update was turned off during the run");
    };

    // 1. a private clone of the fork, with the upstream as a second remote
    await ensureClone();
    await fetchBoth();
    await deps.afterStep?.("fetched", { sha: "", runId: run.id });

    for (let restarts = 0; ; restarts++) {
      await cancelled();
      const forkTip = await rev(`refs/remotes/origin/${forkBranch}`);
      const upHead = await rev(`refs/remotes/upstream/${upBranch}`);
      if (!forkTip) return { state: "failed", error: `The fork branch ${forkBranch} was not found` };
      if (!upHead) return { state: "failed", error: `The upstream branch ${upBranch} was not found` };
      upstreamSha = upHead;
      forkSha = forkTip;
      if ((await git.run(repo, ["merge-base", "--is-ancestor", upHead, forkTip])).code === 0) return { state: "up-to-date", sha: upHead };

      // 2. candidates: newest upstream head first, then older first-parent commits, never past what the fork already contains
      const list = (await git.ok(repo, ["rev-list", "--first-parent", "-n", String(MAX_BACK + 1), upHead, `^${forkTip}`])).split(/\s+/).filter(Boolean);
      const candidates: Candidate[] = list.map((sha) => ({ sha }));
      log.add(`upstream head ${upHead.slice(0, 7)}, fork ${forkTip.slice(0, 7)}, ${candidates.length} candidate(s)`);
      const outcomes: ("conflict" | "verify-failed" | "error")[] = [];
      let headFiles: string[] | undefined;
      let lastError: string | undefined;
      let restart = false;

      for (const [i, cand] of candidates.entries()) {
        await cancelled();
        tried.push(cand.sha);
        await db.upstreamUpdateRun.update({ where: { id: run.id }, data: { upstreamSha, forkSha, triedShas: tried } });
        log.add(`candidate ${i + 1}/${candidates.length}: ${cand.sha.slice(0, 7)}`);

        // 3. merge: no fast-forward, a fixed message, conflicts abort cleanly and are never resolved
        if (fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))) await git.run(repo, ["merge", "--abort"]);
        await git.ok(repo, ["checkout", "-f", "--no-track", "-B", B, `refs/remotes/origin/${forkBranch}`]);
        const mr = await git.run(repo, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${upFull} ${cand.sha.slice(0, 7)} into ${forkBranch}`, cand.sha]);
        if (mr.code !== 0) {
          const files = (await git.run(repo, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).slice(0, 100);
          await git.run(repo, ["merge", "--abort"]);
          if (files.length) {
            log.add(`conflict in ${files.length} file(s)`);
            outcomes.push("conflict");
            if (i === 0) headFiles = files;
          } else {
            lastError = (mr.stderr || mr.stdout).trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300) || "The merge failed";
            outcomes.push("error");
          }
          continue;
        }
        await deps.afterStep?.("merged", { sha: cand.sha, runId: run.id });
        if (await newerHead(upHead, restarts)) {
          restart = true;
          break;
        }

        // 4. verify (only after a clean merge), in the clone, with the command split into an argv and no shell
        let verified = false;
        if (argv) {
          await cancelled();
          log.add(`verify: ${argv.join(" ")}`);
          const v = await runVerify({ argv, cwd: repo, root: dir, timeoutMs: cfg.timeoutSec * 1000, logFile: path.join(dir, "logs", `${run.id}.verify.log`), maxLogBytes: deps.maxLogBytes });
          log.add(v.tail);
          if (v.startError) return finish({ state: "failed", error: v.startError }, upHead, forkTip);
          if (v.timedOut) return finish({ state: "verify-failed", error: `Verify timed out after ${cfg.timeoutSec} s and was stopped` }, upHead, forkTip);
          if (v.code !== 0) {
            log.add(`verify failed (exit ${v.code}) at ${cand.sha.slice(0, 7)}`);
            outcomes.push("verify-failed");
            lastError = `Verify failed (exit ${v.code})`;
            continue;
          }
          verified = true;
        }
        await deps.afterStep?.("verified", { sha: cand.sha, runId: run.id });
        if (await newerHead(upHead, restarts)) {
          restart = true;
          break;
        }

        // 5. promote
        await cancelled();
        await collect(forkTip, cand.sha);
        return promote(cand.sha, verified, mode);
      }
      if (restart) {
        log.add("a newer upstream commit arrived: starting again on it");
        continue;
      }
      await collect(forkTip, upHead);
      const state = exhaustedState(outcomes);
      return { state, files: state === "conflict" ? headFiles : undefined, error: state === "conflict" ? undefined : (lastError ?? "No upstream commit could be merged"), sha: upHead };
    }

    // ---- helpers (closures over the run) ----

    async function finish(o: Outcome, upHead: string, forkTip: string): Promise<Outcome> {
      await collect(forkTip, upHead);
      return o;
    }

    async function rev(ref: string): Promise<string | null> {
      const r = await git.run(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
      return r.code === 0 ? r.stdout.trim() || null : null;
    }

    async function ensureClone() {
      const urlFork = deps.remoteUrl("fork", forkFull);
      const urlUp = deps.remoteUrl("upstream", upFull);
      const valid = fs.existsSync(path.join(repo, ".git")) && (await git.run(repo, ["rev-parse", "--is-inside-work-tree"]).catch(() => ({ code: 1 }))).code === 0;
      if (!valid) {
        if (fs.existsSync(repo)) {
          await assertInside(dir, repo);
          fs.rmSync(repo, { recursive: true, force: true }); // our own scratch clone, damaged: made again
        }
        await git.ok(dir, ["clone", "--no-tags", urlFork, "repo"]);
      }
      if ((await git.run(repo, ["remote", "get-url", "origin"])).code === 0) await git.ok(repo, ["remote", "set-url", "origin", urlFork]);
      else await git.ok(repo, ["remote", "add", "origin", urlFork]);
      if ((await git.run(repo, ["remote", "get-url", "upstream"])).code === 0) await git.ok(repo, ["remote", "set-url", "upstream", urlUp]);
      else await git.ok(repo, ["remote", "add", "upstream", urlUp]);
      await git.ok(repo, ["config", "user.name", "Mergeport"]);
      await git.ok(repo, ["config", "user.email", "mergeport@localhost.invalid"]);
      await git.ok(repo, ["config", "gc.auto", "0"]);
    }

    async function fetchBoth() {
      await git.ok(repo, ["fetch", "--no-tags", "--prune", "origin"]);
      await git.ok(repo, ["fetch", "--no-tags", "upstream"]);
    }

    /** Between steps: has upstream moved past the head this attempt started from? */
    async function newerHead(startedFrom: string, restarts: number): Promise<boolean> {
      if (restarts >= MAX_RESTARTS) return false;
      await git.ok(repo, ["fetch", "--no-tags", "upstream"]);
      const head = await rev(`refs/remotes/upstream/${upBranch}`);
      return !!head && head !== startedFrom;
    }

    async function collect(forkTip: string, to: string) {
      const range = `${forkTip}..${to}`;
      total = Number((await git.run(repo, ["rev-list", "--count", range])).stdout.trim()) || 0;
      const out = (await git.run(repo, ["log", "-n", String(MAX_COMMITS), "--format=%H%x1f%an%x1f%s", range])).stdout;
      commits = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [sha, author, subject] = l.split("\x1f");
        return { sha, author: author ?? "", subject: (subject ?? "").slice(0, 300), url: `https://${deps.host ?? "github.com"}/${upFull}/commit/${sha}` };
      });
    }

    async function promote(sha: string, verified: boolean, how: "pr" | "push"): Promise<Outcome> {
      if (how === "push") {
        // Plain push, never forced: GitHub (git) refuses it if the fork branch moved, and then nothing changes.
        const r = await git.run(repo, ["push", "origin", `refs/heads/${B}:refs/heads/${forkBranch}`]);
        if (r.code !== 0) return { state: "failed", error: `The push to ${forkBranch} was refused: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300)}`, sha };
        log.add(`fast-forwarded ${forkBranch} to ${(await rev(`refs/heads/${B}`))?.slice(0, 7)}`);
        return { state: "promoted", sha };
      }
      const local = await rev(`refs/heads/${B}`);
      const remote = await rev(`refs/remotes/origin/${B}`);
      if (local && local !== remote) {
        // Only the sync branch, only if nobody changed it since the fetch above (the lease names the value we saw).
        const r = await git.run(repo, ["push", `--force-with-lease=refs/heads/${B}:${remote ?? ""}`, "origin", `refs/heads/${B}:refs/heads/${B}`]);
        if (r.code !== 0) return { state: "failed", error: `The push of ${B} was refused: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300)}`, sha };
      }
      const text = pullRequestText({ upstream: upFull, upstreamBranch: upBranch, forkBranch, sha, verify: verified ? "passed" : "untested", commits, totalCommits: total, tried });
      const pr = await (await deps.port()).openOrUpdatePull(m!.fork.owner.login, m!.fork.name, { head: B, base: forkBranch, title: text.title, body: text.body });
      log.add(`${pr.created ? "opened" : "updated"} pull request #${pr.number}`);
      return { state: verified ? "pr-opened" : "merged-untested", prUrl: pr.htmlUrl, sha };
    }
  }
}

/** One in-app notification per notable outcome, to the administrators who can see the fork, unless they turned the kind off. */
async function notifyRun(db: Db, r: { mappingId: string; forkRepoId: string; workspaceId: string; forkName: string; state: UpdateState; prUrl?: string | null; error?: string | null; sha?: string | null }) {
  const what: Partial<Record<UpdateState, string>> = {
    "pr-opened": "Upstream update ready for review",
    "merged-untested": "Upstream update ready for review (not tested)",
    promoted: "Fork updated from upstream",
    conflict: "Upstream update needs you: merge conflict",
    "verify-failed": "Upstream update needs you: verification failed",
    failed: "Upstream update failed",
  };
  const title = `${what[r.state] ?? "Upstream update"}: ${r.forkName}${r.sha ? ` (${r.sha.slice(0, 7)})` : ""}`;
  const admins = await db.member.findMany({ where: { workspaceId: r.workspaceId, status: "ACTIVE", role: "ADMIN" }, select: { userId: true } });
  for (const a of admins) {
    const pref = await db.notificationPref.findUnique({ where: { userId: a.userId } });
    // The kind is not in the Settings list yet (that list is fixed by tests/notify.test.ts); a stored `inApp: false` for it is honoured.
    const own = (pref?.prefs as { kinds?: Record<string, { inApp?: unknown }> } | null | undefined)?.kinds?.["upstream-update"];
    if (own?.inApp === false) continue;
    await db.notification.create({ data: { workspaceId: r.workspaceId, userId: a.userId, repositoryId: r.forkRepoId, kind: "upstream-update", title: title.slice(0, 200), href: `/forks#m-${r.mappingId}` } });
  }
}
