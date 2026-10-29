import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetEnvCache } from "@/lib/env";
import { forgetAllCredentials } from "@/lib/github/bound";
import { resetGhResolution } from "@/lib/github/exec";

export type FakeState = {
  active: string | null;
  accounts: Record<string, { id: number; token: string }>;
  noUserFlag?: boolean;
  offline?: boolean;
  delayMs?: number;
  mode?: "stall" | "tree" | "echo";
  leakTokenToStderr?: boolean;
};
export type FakeCall = { argv: string[]; served: string | null; explicit: boolean; inheritedToken: string | null; ghTokenEnv: string | null; pid: number; kind?: string; method?: string; path?: string; input?: string; asked?: string; mode?: string; grandchild?: number };

const script = path.resolve("tests", "fixtures", "fake gh", "fake-gh.mjs");

/**
 * A fake `gh` that runs as a REAL child process (node, from a directory whose name contains a space). Its state file is
 * edited between calls, which is how `gh auth switch` is simulated. Everything it records is what the process actually saw.
 */
export function useFakeGh(initial: FakeState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp gh "));
  const statePath = path.join(dir, "state.json");
  const logPath = path.join(dir, "calls.log");
  fs.writeFileSync(logPath, "");
  const saved = { cmd: process.env.MERGEPORT_GH_CMD, st: process.env.FAKE_GH_STATE, lg: process.env.FAKE_GH_LOG, host: process.env.MERGEPORT_HOST };
  const write = (s: FakeState) => fs.writeFileSync(statePath, JSON.stringify(s));
  let state = initial;
  write(state);
  process.env.MERGEPORT_GH_CMD = JSON.stringify([process.execPath, script]);
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_LOG = logPath;
  process.env.MERGEPORT_HOST = "github.com";
  resetEnvCache();
  resetGhResolution();
  forgetAllCredentials();
  return {
    dir,
    set(patch: Partial<FakeState>) {
      state = { ...state, ...patch };
      write(state);
    },
    switchTo(login: string | null) {
      this.set({ active: login });
    },
    calls: (): FakeCall[] => fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    apiCalls() {
      return this.calls().filter((c) => c.kind === "api" && c.path !== "user");
    },
    cleanup() {
      for (const [k, v] of [["MERGEPORT_GH_CMD", saved.cmd], ["FAKE_GH_STATE", saved.st], ["FAKE_GH_LOG", saved.lg], ["MERGEPORT_HOST", saved.host]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
      resetGhResolution();
      forgetAllCredentials();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
