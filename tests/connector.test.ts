import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitError, collectSnapshot, runGit, validateRoot } from "@/lib/local/git";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });

let tmp: string;
let repo: string;
let linked: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-conn-"));
  // A path with spaces and shell metacharacters proves arguments are never interpolated.
  repo = path.join(tmp, "my repo & (test) $HOME");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  linked = path.join(tmp, "linked");
  git(repo, "worktree", "add", "-q", "-b", "feature", linked);
  git(repo, "worktree", "lock", linked);
  fs.writeFileSync(path.join(repo, "dirty.txt"), "secret-contents-should-never-leave");
  fs.writeFileSync(path.join(repo, "a.txt"), "changed");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("connector git access", () => {
  it("reports worktrees with branch, HEAD, lock and dirty COUNTS, and never file names or contents", async () => {
    const snap = await collectSnapshot(await validateRoot(repo));
    expect(snap.worktrees).toHaveLength(2);
    const main = snap.worktrees.find((w) => w.branch === "main")!;
    expect(main.dirty).toMatchObject({ unstaged: 1, untracked: 1, staged: 0 });
    const feat = snap.worktrees.find((w) => w.branch === "feature")!;
    expect(feat.locked).toBe(true);
    expect(feat.dirty).toMatchObject({ staged: 0, unstaged: 0, untracked: 0 });
    const json = JSON.stringify(snap);
    expect(json).not.toContain("secret-contents-should-never-leave");
    expect(json).not.toContain("dirty.txt");
    expect(json).not.toContain("a.txt");
  });

  it("detached HEAD and a missing worktree path render truthfully", async () => {
    const det = path.join(tmp, "detached");
    git(repo, "worktree", "add", "-q", "--detach", det);
    let snap = await collectSnapshot(await validateRoot(repo));
    expect(snap.worktrees.find((w) => w.path.endsWith("detached"))).toMatchObject({ detached: true, branch: null });
    fs.rmSync(det, { recursive: true, force: true });
    snap = await collectSnapshot(await validateRoot(repo));
    const gone = snap.worktrees.find((w) => w.path.endsWith("detached"))!;
    expect(gone.missing).toBe(true);
    expect(gone.prunable).toBe(true);
  });

  it("refuses non-git folders, relative paths, subfolders and filesystem roots", async () => {
    const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
    await expect(validateRoot(plain)).rejects.toBeInstanceOf(GitError);
    await expect(validateRoot("relative/path")).rejects.toBeInstanceOf(GitError);
    fs.mkdirSync(path.join(repo, "sub"));
    await expect(validateRoot(path.join(repo, "sub"))).rejects.toBeInstanceOf(GitError);
    await expect(validateRoot(path.parse(tmp).root)).rejects.toBeInstanceOf(GitError);
    await expect(validateRoot(path.join(tmp, "nope"))).rejects.toBeInstanceOf(GitError);
  });

  it("only read-only git subcommands can run; there is no arbitrary command endpoint", async () => {
    for (const bad of ["checkout", "reset", "clean", "fetch", "push", "config", "-c", "worktree-remove"]) {
      await expect(runGit(repo, [bad, "x"])).rejects.toBeInstanceOf(GitError);
    }
    // Injection attempts in a path are just a literal (missing) path, never executed.
    await expect(runGit(path.join(tmp, "x; touch pwned"), ["status"])).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(path.join(tmp, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
  });

  it("is immune to GIT_DIR pointing elsewhere", async () => {
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tmp, "elsewhere");
    try {
      const top = (await runGit(repo, ["rev-parse", "--show-toplevel"])).trim();
      expect(path.resolve(top).toLowerCase()).toBe(path.resolve(repo).toLowerCase());
    } finally {
      if (old === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = old;
    }
  });
});
