import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { GhAbortedError, GhMissingError, GhTimeoutError, defaultGhRunner, findOnPath, ghCandidates, ghExecutable, liveGhProcesses, needsShell, resetGhResolution, terminateAllGh } from "@/lib/github/exec";
import { useFakeGh } from "./fake-gh";

/**
 * EXECUTED here, as real child processes on this machine: argument passing (the fake gh lives in a directory whose name has a
 * space and the node binary's own path has one), stdin, timeouts, cancellation, killing a whole process tree, shutdown.
 * SIMULATED: only the CLI itself (a fake script stands in for gh) and, in the discovery tests, the environment and file
 * system, which are passed in as data. Real gh is touched in the last describe, read-only and locally.
 */
let gh: ReturnType<typeof useFakeGh>;
beforeEach(() => {
  gh = useFakeGh({ active: "alice", accounts: { alice: { id: 1, token: "tok-alice" } } });
});
afterEach(() => {
  terminateAllGh();
  gh.cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describe("argument handling (real subprocess)", () => {
  it("passes every argument through exactly, including spaces, quotes and shell metacharacters", async () => {
    gh.set({ mode: "echo" });
    const nasty = ["a b", 'c"d', "e&f|g", "%PATH%", "$(whoami)", "`id`", "x;y", "tab\there", "unicode-ünï-🙂", "--hostname=evil.example", "", "'single'", "back\\slash\\", "C:\\Program Files\\x y\\"];
    const r = await defaultGhRunner(["api", ...nasty], { input: "line1\nläne2 🙂" });
    expect(r.code).toBe(0);
    const echoed = JSON.parse(r.stdout) as { argv: string[]; input: string };
    expect(echoed.argv).toEqual(["api", ...nasty]);
    expect(echoed.input).toBe("line1\nläne2 🙂");
  });

  it("never runs through a shell: metacharacters create nothing", async () => {
    gh.set({ mode: "echo" });
    const marker = path.join(gh.dir, "pwned.txt");
    await defaultGhRunner(["api", `& echo x > "${marker}"`, `; touch ${marker}`, `| type nul > ${marker}`]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses .cmd and .bat shims rather than running them through a shell", async () => {
    expect(needsShell("C:\\tools\\gh.cmd")).toBe(true);
    expect(needsShell("C:\\tools\\gh.exe")).toBe(false);
    const saved = process.env.MERGEPORT_GH_CMD;
    process.env.MERGEPORT_GH_CMD = JSON.stringify(["C:\\tools\\gh.cmd"]);
    resetEnvCache();
    resetGhResolution();
    try {
      await expect(defaultGhRunner(["--version"])).rejects.toThrow(/\.cmd\/\.bat shim/);
    } finally {
      process.env.MERGEPORT_GH_CMD = saved;
      resetEnvCache();
      resetGhResolution();
    }
  });

  it("a missing executable is reported as missing, not as a hang or a generic failure", async () => {
    const saved = process.env.MERGEPORT_GH_CMD;
    process.env.MERGEPORT_GH_CMD = JSON.stringify([path.join(gh.dir, "no-such-gh.exe")]);
    resetEnvCache();
    resetGhResolution();
    try {
      await expect(defaultGhRunner(["--version"])).rejects.toBeInstanceOf(GhMissingError);
    } finally {
      process.env.MERGEPORT_GH_CMD = saved;
      resetEnvCache();
      resetGhResolution();
    }
  });
});

describe("timeouts, cancellation and cleanup (real subprocess)", () => {
  it("a stalled gh is killed at the timeout and the call rejects", async () => {
    gh.set({ mode: "stall" });
    const pidfile = path.join(gh.dir, "pid");
    process.env.FAKE_GH_PIDFILE = pidfile;
    try {
      const t0 = Date.now();
      await expect(defaultGhRunner(["api", "user"], { timeoutMs: 600 })).rejects.toBeInstanceOf(GhTimeoutError);
      expect(Date.now() - t0).toBeLessThan(4000);
      const pid = Number(fs.readFileSync(pidfile, "utf8"));
      expect(await until(() => !alive(pid))).toBe(true); // the process is really gone
      expect(liveGhProcesses()).toBe(0);
    } finally {
      delete process.env.FAKE_GH_PIDFILE;
    }
  });

  it("an AbortSignal cancels a running call and kills the process", async () => {
    gh.set({ mode: "stall" });
    const pidfile = path.join(gh.dir, "pid");
    process.env.FAKE_GH_PIDFILE = pidfile;
    try {
      const ac = new AbortController();
      const p = defaultGhRunner(["api", "user"], { timeoutMs: 30_000, signal: ac.signal });
      await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").length > 0);
      ac.abort();
      await expect(p).rejects.toBeInstanceOf(GhAbortedError);
      expect(await until(() => !alive(Number(fs.readFileSync(pidfile, "utf8"))))).toBe(true);
      await expect(defaultGhRunner(["api", "user"], { signal: ac.signal })).rejects.toBeInstanceOf(GhAbortedError); // already aborted: never starts
      expect(liveGhProcesses()).toBe(0);
    } finally {
      delete process.env.FAKE_GH_PIDFILE;
    }
  });

  it("the whole process TREE is killed, not just the child (a credential helper must not outlive gh)", async () => {
    gh.set({ mode: "tree" });
    const grandchild = path.join(gh.dir, "grandchild-pid");
    process.env.FAKE_GH_GRANDCHILD = grandchild;
    try {
      const p = defaultGhRunner(["api", "user"], { timeoutMs: 30_000, signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(1500) });
      await expect(p).rejects.toBeInstanceOf(GhAbortedError);
      expect(await until(() => fs.existsSync(grandchild) && fs.readFileSync(grandchild, "utf8").length > 0)).toBe(true);
      const gpid = Number(fs.readFileSync(grandchild, "utf8"));
      expect(await until(() => !alive(gpid), 6000)).toBe(true);
    } finally {
      delete process.env.FAKE_GH_GRANDCHILD;
    }
  });

  it("shutdown terminates every call still running", async () => {
    gh.set({ mode: "stall" });
    const calls = [defaultGhRunner(["api", "a"], { timeoutMs: 30_000 }), defaultGhRunner(["api", "b"], { timeoutMs: 30_000 })];
    const settled = Promise.allSettled(calls);
    await until(() => liveGhProcesses() === 2);
    expect(liveGhProcesses()).toBe(2);
    terminateAllGh();
    const results = await settled;
    expect(await until(() => liveGhProcesses() === 0)).toBe(true);
    for (const r of results) expect(r.status === "fulfilled" ? r.value.code : 1).not.toBe(0); // killed: never a successful result
  });
});

describe("executable discovery", () => {
  it("lists the usual Windows install locations from the environment it is given", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\Jo Smith\\AppData\\Local" } as unknown as NodeJS.ProcessEnv;
    expect(ghCandidates(env, "win32")).toEqual([
      "C:\\Program Files\\GitHub CLI\\gh.exe",
      "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
      "C:\\Users\\Jo Smith\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
      "C:\\Users\\Jo Smith\\AppData\\Local\\GitHub CLI\\gh.exe",
    ]);
  });

  it("finds gh on PATH (paths with spaces, quoted entries) and ignores cmd shims", () => {
    const env = { PATH: '"C:\\Tools With Space";C:\\Windows' } as unknown as NodeJS.ProcessEnv;
    const only = (x: string) => (p: string) => p.toLowerCase() === x.toLowerCase();
    expect(findOnPath("gh", env, "win32", only("C:\\Tools With Space\\gh.exe"))).toBe("C:\\Tools With Space\\gh.exe");
    expect(findOnPath("gh", env, "win32", only("C:\\Tools With Space\\gh.cmd"))).toBeNull();
    expect(findOnPath("gh", { PATH: "/usr/bin:/opt/x" } as unknown as NodeJS.ProcessEnv, "linux", (p) => p === "/opt/x/gh")).toBe("/opt/x/gh");
  });

  it("falls back to a known install location when PATH does not have gh", () => {
    const saved = process.env.MERGEPORT_GH_CMD;
    delete process.env.MERGEPORT_GH_CMD;
    resetEnvCache();
    try {
      const env = { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" } as unknown as NodeJS.ProcessEnv;
      expect(ghExecutable(env, "win32", (p) => p === "C:\\Program Files\\GitHub CLI\\gh.exe")).toEqual({ file: "C:\\Program Files\\GitHub CLI\\gh.exe", prefix: [] });
      expect(ghExecutable(env, "win32", () => false)).toBeNull();
    } finally {
      if (saved !== undefined) process.env.MERGEPORT_GH_CMD = saved;
      resetEnvCache();
    }
  });
});

describe("the real GitHub CLI on this machine (read-only, local; no GitHub request is made)", () => {
  const real = (() => {
    const saved = process.env.MERGEPORT_GH_CMD;
    delete process.env.MERGEPORT_GH_CMD;
    resetEnvCache();
    try {
      return ghExecutable();
    } finally {
      if (saved !== undefined) process.env.MERGEPORT_GH_CMD = saved;
      resetEnvCache();
    }
  })();

  it.skipIf(!real)("is found, runs with an explicit path, and supports naming an account (`gh auth token --user`)", () => {
    const exe = real!;
    expect(path.isAbsolute(exe.file)).toBe(true);
    expect(needsShell(exe.file)).toBe(false);
    const run = (...a: string[]) => execFileSync(exe.file, [...exe.prefix, ...a], { encoding: "utf8", windowsHide: true, shell: false });
    expect(run("--version")).toMatch(/gh version \d+\.\d+/);
    expect(run("auth", "token", "--help")).toMatch(/--user/);
  });

  it.skipIf(!real)("our own runner reaches the real executable the same way (executed, no network)", async () => {
    const saved = process.env.MERGEPORT_GH_CMD;
    delete process.env.MERGEPORT_GH_CMD;
    resetEnvCache();
    resetGhResolution();
    try {
      const r = await defaultGhRunner(["--version"], { timeoutMs: 15_000 });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/gh version/);
    } finally {
      if (saved !== undefined) process.env.MERGEPORT_GH_CMD = saved;
      resetEnvCache();
      resetGhResolution();
    }
  });

  it("is reported as it is for this platform", () => {
    expect(os.platform()).toBeTruthy();
  });
});
