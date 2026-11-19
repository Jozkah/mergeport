import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeEqual } from "@/lib/crypto";

/**
 * Fresh sign-in links for the desktop shortcut. The launcher's own link works once and only at startup, so a shortcut used later had
 * to restart the whole app to get a new one. Instead the launcher leaves a small file only this Windows user can read (the same
 * trust as the profile database and its key), and the running app hands out a new single-use link to whoever shows the secret in it.
 * A web page cannot: it cannot read the file and cannot send the header.
 */

export const FRESH_LINK_TTL_MS = 2 * 60 * 1000;
const MAX_OUTSTANDING = 5;
export const CONTROL_HEADER = "x-mergeport-control";

export type ControlInfo = { port: number; secret: string; pid: number; stamp: string | null };

const g = globalThis as typeof globalThis & { __mpFreshLinks?: Map<string, number> };
const store = () => (g.__mpFreshLinks ??= new Map<string, number>());

/** Mints a single-use token. Only a few can be outstanding at once; the oldest is dropped. */
export function mintFreshLink(now = Date.now(), s = store()): string {
  for (const [t, exp] of s) if (exp <= now) s.delete(t);
  while (s.size >= MAX_OUTSTANDING) s.delete(s.keys().next().value as string);
  const token = randomBytes(24).toString("base64url");
  s.set(token, now + FRESH_LINK_TTL_MS);
  return token;
}

/** Uses a minted token: true once, while it is young. */
export function takeFreshLink(given: string, now = Date.now(), s = store()): boolean {
  let hit: string | null = null;
  for (const [t, exp] of s) {
    if (safeEqual(given, t)) hit = t;
    if (exp <= now) s.delete(t);
  }
  if (!hit || !s.has(hit)) return false;
  s.delete(hit);
  return true;
}

/** Does the caller know this process's control secret? */
export function controlSecretOk(given: string | null, expected: string | undefined): boolean {
  return !!given && !!expected && safeEqual(given, expected);
}

export const controlFile = (home: string) => path.join(home, "control.json");

export function writeControlFile(home: string, info: ControlInfo, restrict: (file: string) => void = () => {}) {
  fs.mkdirSync(home, { recursive: true });
  const file = controlFile(home);
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  restrict(file);
}

/** Removes the file, but only if it still names this process: a newer launcher's file is not ours to delete. */
export function removeControlFile(home: string, pid: number) {
  try {
    const file = controlFile(home);
    const cur = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ControlInfo>;
    if (cur.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // nothing to remove
  }
}
