import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ghStatus, type GhStatus } from "@/lib/github/gh";

/**
 * Who `gh` has selected right now, compared with the account this profile belongs to. This is INFORMATION for the person
 * (a banner when they differ); it is not what keeps writes safe. Safety comes from bound.ts: every call runs with this
 * profile's own credential, verified against its numeric id, so a different selection cannot change who a call runs as.
 * Page renders use the last known answer and refresh it in the background, so an offline start never waits on `gh`.
 */

type Cache = { at: number; status: GhStatus };
const g = globalThis as typeof globalThis & { __mpIdentity?: Cache; __mpIdentityInflight?: Promise<GhStatus> };
/** Short on purpose: after `gh auth switch`, at most this long passes before the app notices and stops acting. */
const TTL_MS = 10_000;

export async function currentGhStatus(force = false, o: { swr?: boolean; timeoutMs?: number } = {}): Promise<GhStatus> {
  const c = g.__mpIdentity;
  if (!force && c) {
    if (Date.now() - c.at < TTL_MS) return c.status;
    if (o.swr) {
      void refresh(o.timeoutMs); // answer now from what we know; learn the new answer for the next render
      return c.status;
    }
  }
  return refresh(o.timeoutMs);
}

function refresh(timeoutMs?: number): Promise<GhStatus> {
  // One `gh api user` at a time: concurrent renders share it instead of each spawning a process.
  g.__mpIdentityInflight ??= ghStatus(undefined, undefined, { timeoutMs })
    .then((status) => {
      g.__mpIdentity = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      g.__mpIdentityInflight = undefined;
    });
  return g.__mpIdentityInflight;
}

export type ProfileCheck = { kind: "demo" } | { kind: "ok"; login: string } | { kind: "no-profile"; gh: GhStatus } | { kind: "mismatch"; profileLogin: string; ghLogin: string } | { kind: "gh-unavailable"; gh: GhStatus; profileLogin: string };

export async function checkProfile(): Promise<ProfileCheck> {
  if (isDemo()) return { kind: "demo" };
  const profile = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  const gh = await currentGhStatus(false, { swr: true, timeoutMs: 5_000 });
  if (!profile) return { kind: "no-profile", gh };
  if (gh.state === "ok") return gh.identity.id === profile.githubId ? { kind: "ok", login: profile.login } : { kind: "mismatch", profileLogin: profile.login, ghLogin: gh.identity.login };
  // gh missing or signed out: the local cache stays readable, but nothing is sent to GitHub.
  return { kind: "gh-unavailable", gh, profileLogin: profile.login };
}
