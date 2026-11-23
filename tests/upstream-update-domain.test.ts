import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandError, MAX_BACK, cleanConfig, exhaustedState, pullRequestText, splitCommand, windowsNodeTool } from "@/lib/domain/upstream-update";
import { assertInside, createGitWriter, gitEnv, isInside, redactUrls } from "@/lib/local/git-write";
import { runVerify, verifyEnv } from "@/lib/local/verify-run";
import { updaterDir } from "@/lib/local/upstream-updater";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(process.platform === "win32" && fs.existsSync("C:/tmp") ? "C:/tmp" : os.tmpdir(), "mpd-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("splitCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitCommand("npm test")).toEqual(["npm", "test"]);
    expect(splitCommand(`  node   "my script.js"  'a b'  c"d e"f `)).toEqual(["node", "my script.js", "a b", "cd ef"]);
    expect(splitCommand(`say "he said \\"hi\\""`)).toEqual(["say", 'he said "hi"']);
    expect(splitCommand(`"" x`)).toEqual(["", "x"]);
    expect(splitCommand("")).toEqual([]);
  });
  it("keeps Windows paths intact (a backslash is an ordinary character)", () => {
    expect(splitCommand(String.raw`"C:\Program Files\nodejs\node.exe" C:\work\verify.js`)).toEqual([String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\work\verify.js`]);
  });
  it("never interprets a shell metacharacter: each stays a plain character of an argument", () => {
    expect(splitCommand("echo a;b|c&&d>e<f $HOME `id` $(id) *.js ~ !x")).toEqual(["echo", "a;b|c&&d>e<f", "$HOME", "`id`", "$(id)", "*.js", "~", "!x"]);
    expect(splitCommand("tool ; rm -rf /")).toEqual(["tool", ";", "rm", "-rf", "/"]); // `;` is an argument to tool, not a separator
    expect(splitCommand(`a "b;c" 'd|e'`)).toEqual(["a", "b;c", "d|e"]);
  });
  it("refuses unclosed quotes, null characters and absurd sizes", () => {
    expect(() => splitCommand(`a "b`)).toThrow(CommandError);
    expect(() => splitCommand("a\0b")).toThrow(CommandError);
    expect(() => splitCommand("x ".repeat(1500))).toThrow(CommandError);
    expect(() => splitCommand(Array.from({ length: 70 }, (_, i) => `a${i}`).join(" "))).toThrow(/more than/);
  });
});

describe("cleanConfig", () => {
  const map = { forkBranch: "main", upstreamBranch: "main" };
  it("defaults, trims and validates", () => {
    expect(cleanConfig({ enabled: "on", verifyCommand: "  npm test ", timeoutSec: "300" }, map)).toEqual({ enabled: true, verifyCommand: "npm test", promote: "pr", timeoutSec: 300, branchName: "mergeport/upstream-sync" });
    expect(cleanConfig({}, map)).toMatchObject({ enabled: false, verifyCommand: null, promote: "pr", timeoutSec: 1200 });
  });
  it("refuses push without a verify command", () => {
    expect(() => cleanConfig({ promote: "push" }, map)).toThrow(/needs a verify command/);
    expect(cleanConfig({ promote: "push", verifyCommand: "node t.js" }, map).promote).toBe("push");
  });
  it("bounds the time limit (10 s to 2 h) and rejects bad or colliding branch names", () => {
    expect(() => cleanConfig({ timeoutSec: 5 }, map)).toThrow(/time limit/);
    expect(() => cleanConfig({ timeoutSec: 7201 }, map)).toThrow(/time limit/);
    expect(cleanConfig({ timeoutSec: 7200 }, map).timeoutSec).toBe(7200);
    for (const bad of ["main", "a..b", "-x", "a b", "x/", "x.lock", "refs//x"]) expect(() => cleanConfig({ branchName: bad }, map), bad).toThrow();
    expect(() => cleanConfig({ verifyCommand: 'a "b' }, map)).toThrow(/quote/);
  });
});

describe("text and rules", () => {
  it("shows untrusted subjects as inert code (no mentions, links or markup)", () => {
    const t = pullRequestText({ upstream: "u/p", upstreamBranch: "main", forkBranch: "main", sha: "a".repeat(40), verify: "untested", totalCommits: 3, tried: ["b".repeat(40), "a".repeat(40)], commits: [{ sha: "c".repeat(40), subject: "fix @octocat `rm -rf` [x](http://evil)\nbody", author: "@evil", url: "https://github.com/u/p/commit/ccc" }] });
    expect(t.body).toContain("`fix @octocat  rm -rf  [x](http://evil) body`");
    for (const m of t.body.matchAll(/@octocat|@evil/g)) expect((t.body.slice(0, m.index).match(/`/g) ?? []).length % 2, "mention outside a code span").toBe(1);
    expect(t.body).toContain("Not tested");
    expect(t.body).toContain("and 2 more");
    expect(t.body).toContain("conflicted or failed verification");
    expect(t.title).toBe("Merge u/p@aaaaaaa into main");
  });
  it("exhausted candidates: all conflicts is conflict, a verify failure wins, anything else is a failure", () => {
    expect(exhaustedState(["conflict", "conflict"])).toBe("conflict");
    expect(exhaustedState(["conflict", "verify-failed"])).toBe("verify-failed");
    expect(exhaustedState(["conflict", "error"])).toBe("failed");
    expect(exhaustedState([])).toBe("failed");
    expect(MAX_BACK).toBe(6);
  });
  it("maps npm and npx to node's own scripts on Windows, and nothing else", () => {
    const ok = () => true;
    expect(windowsNodeTool(["npm", "test"], "C:\\n\\node.exe", ok)).toEqual(["C:\\n\\node.exe", "C:\\n\\node_modules\\npm\\bin\\npm-cli.js", "test"]);
    expect(windowsNodeTool(["npx.cmd", "x"], "C:\\n\\node.exe", ok)?.[1]).toMatch(/npx-cli\.js$/);
    expect(windowsNodeTool(["pnpm", "test"], "C:\\n\\node.exe", ok)).toBeNull();
    expect(windowsNodeTool(["npm", "test"], "C:\\n\\node.exe", () => false)).toBeNull();
  });
});

describe("environments and redaction", () => {
  it("verify runs with PATH, SYSTEMROOT, HOME/USERPROFILE and CI=1 only", () => {
    process.env.GH_TOKEN = "secret-token";
    try {
      const e = verifyEnv();
      expect(Object.keys(e).every((k) => ["PATH", "SYSTEMROOT", "HOME", "USERPROFILE", "CI"].includes(k))).toBe(true);
      expect(e.CI).toBe("1");
      expect(JSON.stringify(e)).not.toMatch(/secret-token/);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
  it("git runs with no inherited GIT_DIR / GIT_WORK_TREE and never prompts", () => {
    process.env.GIT_DIR = "C:/elsewhere";
    process.env.GIT_WORK_TREE = "C:/elsewhere";
    try {
      const e = gitEnv();
      expect(e.GIT_DIR).toBeUndefined();
      expect(e.GIT_WORK_TREE).toBeUndefined();
      expect(e.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });
  it("redacts URL credentials", () => {
    expect(redactUrls("fatal: unable to access 'https://user:ghp_abc123@github.com/o/r.git/'")).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(redactUrls("push https://x-access-token:tok@host/a ok https://github.com/o/r")).toBe("push https://***@host/a ok https://github.com/o/r");
  });
});

describe("path confinement", () => {
  it("the mapping id cannot leave the updater folder", () => {
    expect(updaterDir("/h", "abc123")).toMatch(/updater[\\/]abc123$/);
    for (const bad of ["..", "../x", "a/b", "a\\b", "", "x".repeat(65), "a b"]) expect(() => updaterDir("/h", bad), bad).toThrow();
  });
  it("assertInside accepts the folder and its children and refuses anything else, including links out of it", async () => {
    const root = tmp();
    const sibling = tmp();
    fs.mkdirSync(`${root}/repo`);
    await assertInside(root, root);
    await assertInside(root, `${root}/repo`);
    await expect(assertInside(root, sibling)).rejects.toThrow(/outside/);
    await expect(assertInside(root, `${root}/..`)).rejects.toThrow(/outside/);
    await expect(assertInside(root, `${root}/missing`)).rejects.toThrow(/outside/);
    fs.symlinkSync(sibling, `${root}/link`, "junction");
    expect(await isInside(root, `${root}/link`)).toBe(false); // a link to the outside is judged by where it leads
  });
});

describe("git writer allow-list", () => {
  const writer = (root: string, pushRefs = ["refs/heads/mergeport/upstream-sync"]) => createGitWriter({ root, pushRefs });
  it("refuses subcommands that are not on the list", async () => {
    const root = tmp();
    const w = writer(root);
    for (const sub of ["clean", "gc", "rebase", "cherry-pick", "tag", "stash", "init", "ls-remote", "pull", "worktree", "submodule", "am", "apply", "filter-branch", "update-ref", "show"]) await expect(w.run(root, [sub]), sub).rejects.toThrow(/not permitted/);
  });
  it("refuses cwd outside the updater folder before running anything", async () => {
    const root = tmp();
    const other = tmp();
    await expect(writer(root).run(other, ["status"])).rejects.toThrow(/outside the updater folder/);
  });
  it("push: only origin, one explicit refspec on the allow-list, never forced, deleting, mirroring or tagging", async () => {
    const root = tmp();
    const w = writer(root);
    const refused = [
      ["push", "upstream", "refs/heads/mergeport/upstream-sync:refs/heads/mergeport/upstream-sync"],
      ["push", "origin", "refs/heads/x:refs/heads/main"], // not an allowed destination
      ["push", "origin", ":refs/heads/mergeport/upstream-sync"], // delete
      ["push", "origin", "+refs/heads/mergeport/upstream-sync:refs/heads/mergeport/upstream-sync"],
      ["push", "--force", "origin", "refs/heads/mergeport/upstream-sync:refs/heads/mergeport/upstream-sync"],
      ["push", "-f", "origin", "refs/heads/mergeport/upstream-sync:refs/heads/mergeport/upstream-sync"],
      ["push", "--delete", "origin", "mergeport/upstream-sync"],
      ["push", "--mirror", "origin"],
      ["push", "--all", "origin"],
      ["push", "--tags", "origin"],
      ["push", "origin", "HEAD"],
      ["push", "https://example.test/x.git", "refs/heads/a:refs/heads/mergeport/upstream-sync"],
      ["push"],
    ];
    for (const args of refused) await expect(w.run(root, args), args.join(" ")).rejects.toThrow(/not permitted|must name|needs an explicit|may not update/);
    // an allowed shape passes the checks (it then fails to run for lack of a repository, which is a result, not a refusal)
    const r = await w.run(root, ["push", "--force-with-lease=refs/heads/mergeport/upstream-sync:", "origin", "refs/heads/mergeport/upstream-sync:refs/heads/mergeport/upstream-sync"]);
    expect(r.code).not.toBe(0);
  });
  it("branch never deletes or renames, config only touches the few keys, diff only lists names, remote only origin/upstream", async () => {
    const root = tmp();
    const w = writer(root);
    for (const args of [["branch", "-D", "x"], ["branch", "--delete", "x"], ["branch", "-d", "x"], ["branch", "-m", "a", "b"], ["branch", "-M", "b"], ["branch", "-f", "x"]]) await expect(w.run(root, args), args.join(" ")).rejects.toThrow(/may not|not permitted/);
    for (const args of [["config", "alias.x", "!rm -rf /"], ["config", "core.sshCommand", "calc"], ["config", "core.hooksPath", "/x"], ["config", "credential.helper", "x"], ["config", "--global", "user.name", "x"], ["config", "--unset", "user.name"], ["config", "--add", "user.name", "x"]]) await expect(w.run(root, args), args.join(" ")).rejects.toThrow(/not permitted/);
    await expect(w.run(root, ["diff"])).rejects.toThrow(/name-only/);
    await expect(w.run(root, ["diff", "--output=x.txt", "--name-only"])).rejects.toThrow(/not permitted/);
    await expect(w.run(root, ["log", "--output=x.txt"])).rejects.toThrow(/not permitted/);
    await expect(w.run(root, ["remote", "add", "evil", "https://x/y"])).rejects.toThrow(/origin and upstream/);
    await expect(w.run(root, ["remote", "remove", "origin"])).rejects.toThrow(/may only/);
    await expect(w.run(root, ["fetch", "--upload-pack=calc", "origin"])).rejects.toThrow(/not permitted/);
    await expect(w.run(root, ["clone", "--template=/x", "u", "repo"])).rejects.toThrow(/not permitted/);
    await expect(w.run(root, ["clone", "u", "../escape"])).rejects.toThrow(/plain folder name/);
  });
});

describe("verify runner", () => {
  const node = process.execPath.replace(/\\/g, "/");
  it("runs with shell:false in the clone folder, with the scrubbed environment", async () => {
    const root = tmp();
    fs.mkdirSync(`${root}/repo`);
    fs.writeFileSync(`${root}/repo/check.cjs`, `const k=Object.keys(process.env).map(x=>x.toUpperCase());const bad=k.filter(x=>/TOKEN|^GH_|GITHUB|MERGEPORT|^DEMO|^GIT_/.test(x));console.log("ENV:"+bad.join(",")+"|CI="+process.env.CI+"|cwd="+process.cwd().replace(/\\\\/g,"/").split("/").pop());process.exit(bad.length?3:0)`);
    process.env.GH_TOKEN = "t";
    try {
      const r = await runVerify({ argv: [node, "check.cjs"], cwd: `${root}/repo`, root, timeoutMs: 20_000, logFile: `${root}/v.log` });
      expect(r.tail).toContain("|CI=1|cwd=repo");
      expect(r.code).toBe(0);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
  it("hands metacharacters to the program as plain arguments", async () => {
    const root = tmp();
    fs.mkdirSync(`${root}/repo`);
    fs.writeFileSync(`${root}/repo/args.cjs`, `console.log(JSON.stringify(process.argv.slice(2)))`);
    const argv = splitCommand(`"${node}" args.cjs "a;b" && echo pwned > ${root}/pwned.txt | x $(id)`);
    const r = await runVerify({ argv, cwd: `${root}/repo`, root, timeoutMs: 20_000, logFile: `${root}/v.log` });
    expect(JSON.parse(r.tail.trim())).toEqual(["a;b", "&&", "echo", "pwned", ">", `${root}/pwned.txt`, "|", "x", "$(id)"]);
    expect(fs.existsSync(`${root}/pwned.txt`)).toBe(false);
  });
  it("kills the process on timeout and says so", async () => {
    const root = tmp();
    fs.mkdirSync(`${root}/repo`);
    fs.writeFileSync(`${root}/repo/hang.cjs`, `require("fs").writeFileSync(${JSON.stringify(`${root}/pid.txt`)}, String(process.pid)); setInterval(()=>{}, 1000)`);
    const r = await runVerify({ argv: [node, "hang.cjs"], cwd: `${root}/repo`, root, timeoutMs: 1500, logFile: `${root}/v.log` });
    expect(r.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(`${root}/pid.txt`, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive()).toBe(false);
  });
  it("caps the log it writes but still drains the process, and refuses cwd outside the folder or a .cmd script", async () => {
    const root = tmp();
    const other = tmp();
    fs.mkdirSync(`${root}/repo`);
    fs.writeFileSync(`${root}/repo/noisy.cjs`, `for(let i=0;i<200;i++)console.log("x".repeat(100))`);
    const r = await runVerify({ argv: [node, "noisy.cjs"], cwd: `${root}/repo`, root, timeoutMs: 20_000, logFile: `${root}/v.log`, maxLogBytes: 1000 });
    expect(r.code).toBe(0);
    expect(r.logTruncated).toBe(true);
    expect(fs.statSync(`${root}/v.log`).size).toBeLessThan(1200);
    await expect(runVerify({ argv: [node, "x"], cwd: other, root, timeoutMs: 1000, logFile: `${root}/v2.log` })).rejects.toThrow(/outside/);
    const cmd = await runVerify({ argv: ["build.cmd"], cwd: `${root}/repo`, root, timeoutMs: 1000, logFile: `${root}/v3.log` });
    expect(cmd.startError).toMatch(/without a shell/);
  });
});
