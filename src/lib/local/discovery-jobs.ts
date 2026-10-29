import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { currentGhStatus } from "@/lib/local/identity";
import { ghFetch } from "@/lib/github/gh";
import { discoverAll, portForDiscovery } from "@/lib/github/factory";
import type { Discovery } from "@/lib/github/port";
import { authKeysToRecheck, cancelAllDiscovery, dueKeys, isRefreshing, readCached, recoverInterrupted, refreshInBackground, type CachedView } from "@/lib/local/discovery";
import { profileRunner } from "@/lib/local/profile-runner";
import { getEngine, localActor, notifyChange } from "@/lib/local/runtime";
import { terminateAllGh } from "@/lib/github/exec";
import { TeamService, type InvitationStatus, type SpaceCandidate } from "@/lib/team/service";

/** The things the Team and Connect pages show from the local cache and refresh in the background. */
export type InvitationRow = { id: number; fullName: string; inviter: string; permission: string };
export const KEY_REPOS = "repos";
export const KEY_INVITATIONS = "invitations";
export const KEY_CANDIDATES = "candidates";
export const keyInvitationStatus = (spaceId: string) => `inv-status:${spaceId}`;
const PER_CALL_MS = 20_000;

async function teamFor(signal: AbortSignal) {
  const actor = await localActor();
  if (!actor) throw new Error("No GitHub profile");
  return new TeamService(db, ghFetch(profileRunner(db), undefined, { signal, timeoutMs: PER_CALL_MS }), actor, await getEngine());
}

/** A team service whose every GitHub call is cancelled (and its `gh` process killed) after `ms`. For the rare call a person is waiting on. */
export async function teamWithDeadline(ms: number) {
  return teamFor(AbortSignal.timeout(ms));
}

/** Starts a background refresh for a key. Returns at once; never throws; a second call while one is running shares it. */
export function startDiscovery(key: string, demoLogin?: string): void {
  if (isDemo() && key !== KEY_REPOS) return; // demo mode has no GitHub: only the synthetic repository list exists
  const opts = { onChange: notifyChange };
  if (key === KEY_REPOS) {
    void refreshInBackground<Discovery>(db, key, async (signal) => {
      const actor = isDemo() ? { id: 0n, login: demoLogin ?? "owner-demo" } : await localActor();
      if (!actor) throw new Error("No GitHub profile");
      return discoverAll(await portForDiscovery(db, { id: actor.id.toString(), login: actor.login }, { signal, timeoutMs: PER_CALL_MS }));
    }, opts);
  } else if (key === KEY_INVITATIONS) {
    void refreshInBackground<InvitationRow[]>(db, key, async (signal) => (await teamFor(signal)).myInvitations(), opts);
  } else if (key === KEY_CANDIDATES) {
    void refreshInBackground<SpaceCandidate[]>(db, key, async (signal) => (await teamFor(signal)).candidates(), opts);
  } else if (key.startsWith("inv-status:")) {
    const spaceId = key.slice("inv-status:".length);
    void refreshInBackground<InvitationStatus[]>(db, key, async (signal) => {
      const space = await db.space.findUnique({ where: { id: spaceId } });
      if (!space) return [];
      return (await teamFor(signal)).invitationStatuses(space);
    }, opts);
  }
}

export const cached = {
  repos: () => readCached<Discovery>(db, KEY_REPOS),
  invitations: () => readCached<InvitationRow[]>(db, KEY_INVITATIONS),
  candidates: () => readCached<SpaceCandidate[]>(db, KEY_CANDIDATES),
  invitationStatus: (spaceId: string) => readCached<InvitationStatus[]>(db, keyInvitationStatus(spaceId)),
};
export type { CachedView };
export const refreshing = (key: string) => isRefreshing(db, key);

/** Scheduler hook: retry what is due, once, bounded. Does nothing for a profile that is not signed in. */
export async function tickDiscovery(): Promise<number> {
  if (isDemo()) return 0;
  const keys = await dueKeys(db);
  for (const k of keys) startDiscovery(k);
  const stuck = await authKeysToRecheck(db);
  if (stuck.length > 0 && (await currentGhStatus(false, { swr: true, timeoutMs: 5_000 })).state === "ok") for (const k of stuck) startDiscovery(k);
  return keys.length;
}

/** Startup: attempts that a crash interrupted are marked as such. */
export const recoverDiscovery = () => recoverInterrupted(db);

/** Shutdown: cancel background refreshes and kill every `gh` process still running. */
export function shutdownDiscovery(): void {
  cancelAllDiscovery(db);
  terminateAllGh();
}
