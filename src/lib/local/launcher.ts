/**
 * Pure-ish helpers for scripts/start-local.ts, kept here so they are testable without spawning a build or a server.
 *
 * - build stamp: the launcher rebuilds when the code it would serve is not the code it migrated the database for;
 * - build retry: a first `next build` in a fresh process can stop with exit 1 after it finished (on an upgrade notice);
 * - relaunch: a context switch (child exit 75) reopens the app and its new one-time link in the browser.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RESTART_EXIT_CODE } from "./restart-code";

export { RESTART_EXIT_CODE };
export const STAMP_FILE = path.join(".next", "mergeport-built-for");
const BUILD_ID = path.join(".next", "BUILD_ID");
/** Turbopack's links to server packages (better-sqlite3, Prisma). `next start` cannot load the app without them, and disk cleaners delete them. */
const EXTERNALS = path.join(".next", "node_modules");
/** What EXTERNALS held right after the build, so a later check knows what must still be there. */
const EXTERNALS_RECORD = path.join(".next", "mergeport-externals.json");

/** Entry names in EXTERNALS, scoped packages as "@scope/name". */
const listExternals = (root: string): string[] => {
  const dir = path.join(root, EXTERNALS);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((e) => (e.startsWith("@") ? fs.readdirSync(path.join(dir, e)).map((s) => `${e}/${s}`) : [e]));
};

/** True when a recorded server package link is gone (existsSync follows the link, so a dangling one counts as gone). */
const externalsMissing = (root: string): boolean => {
  const rec = path.join(root, EXTERNALS_RECORD);
  if (!fs.existsSync(rec)) return false;
  let names: unknown;
  try {
    names = JSON.parse(fs.readFileSync(rec, "utf8"));
  } catch {
    return false;
  }
  return Array.isArray(names) && names.some((n) => typeof n === "string" && !fs.existsSync(path.join(root, EXTERNALS, n)));
};
/** Files whose change needs a rebuild even without a commit (dependencies, database client). */
const HASHED = ["package-lock.json", path.join("prisma", "schema.prisma")];

export type StampDeps = { gitHead?: (root: string) => string | null };

const gitHead = (root: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

/** What the build in .next must have been made from: git HEAD plus a hash of the lockfile and schema. Null when git is unavailable. */
export function currentStamp(root: string, deps: StampDeps = {}): string | null {
  const head = (deps.gitHead ?? gitHead)(root);
  if (!head) return null;
  const h = createHash("sha256");
  for (const f of HASHED) {
    const p = path.join(root, f);
    h.update(f + "\0" + (fs.existsSync(p) ? fs.readFileSync(p) : "") + "\0");
  }
  return `${head} ${h.digest("hex").slice(0, 16)}`;
}

const newestMtime = (p: string): number => {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const e of fs.readdirSync(p)) max = Math.max(max, newestMtime(path.join(p, e)));
  return max;
};

/** Why a build is needed, or null when the existing build matches. Without git it compares source mtimes with BUILD_ID. */
export function buildReason(root: string, deps: StampDeps = {}): string | null {
  const buildId = path.join(root, BUILD_ID);
  if (!fs.existsSync(buildId)) return "no build yet";
  if (externalsMissing(root)) return "the build's server packages were deleted";
  const stamp = currentStamp(root, deps);
  if (stamp) {
    const stampFile = path.join(root, STAMP_FILE);
    const built = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : "";
    return built === stamp ? null : "the code changed since the last build";
  }
  const builtAt = fs.statSync(buildId).mtimeMs;
  const src = Math.max(newestMtime(path.join(root, "src")), ...HASHED.map((f) => newestMtime(path.join(root, f))));
  return src > builtAt ? "source files are newer than the last build" : null;
}

/** Records what the finished build was made from (no-op without git: the mtime fallback needs no stamp) and which server packages it linked. */
export function writeStamp(root: string, deps: StampDeps = {}) {
  fs.writeFileSync(path.join(root, EXTERNALS_RECORD), JSON.stringify(listExternals(root)));
  const stamp = currentStamp(root, deps);
  if (stamp) fs.writeFileSync(path.join(root, STAMP_FILE), stamp + "\n");
}

export type BuildRun = () => Promise<{ code: number | null; output: string }>;

/**
 * Runs the build, and once more when it stopped with exit 1 although it got far enough to write BUILD_ID or print the route
 * table, or when it stopped on Next.js's one-time notice asking for a retry: a second run builds. Other failures are not retried.
 */
export async function buildWithRetry(root: string, run: BuildRun): Promise<{ ok: boolean; attempts: number; code: number | null }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const { code, output } = await run();
    if (code === 0) return { ok: true, attempts, code };
    const finishedWork = fs.existsSync(path.join(root, BUILD_ID)) || /Route \((app|pages)\)/.test(output);
    const stoppedOnNotice = /Retry the same command/i.test(output); // the notice can also come before any work
    if (attempts >= 2 || code !== 1 || !(finishedWork || stoppedOnNotice)) return { ok: false, attempts, code };
  }
}

/**
 * What the launcher does when its app process exits. Exit 75 means a user clicked a context switch in a browser, so the new
 * one-time link is opened there even under --no-open: that flag only keeps the first start (autostart, shortcut) from popping a
 * window, while here the person is already waiting in the browser and the UI told them it would reopen.
 */
export function onChildExit(
  code: number | null,
  deps: { relaunch: () => Promise<string>; openInBrowser: (url: string) => void; exit: (code: number) => void; log?: (m: string) => void },
): Promise<void> | void {
  if (code !== RESTART_EXIT_CODE) return deps.exit(code ?? 0);
  deps.log?.("Switching context: restarting Mergeport…");
  return deps.relaunch().then(deps.openInBrowser, (e) => {
    console.error(e instanceof Error ? e.message : e);
    deps.exit(1);
  });
}
