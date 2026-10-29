import { EventEmitter } from "node:events";
import type { Space } from "@/generated/prisma/client";
import { db, resolveDbFile } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ghFetch } from "@/lib/github/gh";
import { profileRunner } from "@/lib/local/profile-runner";
import { GitHubRest } from "@/lib/github/rest";
import { SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { TeamService } from "@/lib/team/service";
import { HubTeamService } from "@/lib/team/hub-service";
import { httpHubAdmin, hubSessionPort } from "@/lib/hub/ports-impl";
import { hubBackendId } from "@/lib/local/backends";
import { mergeportHome } from "@/lib/local/profile";
import { readHubs } from "@/lib/local/registry";
import { env } from "@/lib/env";

/**
 * Per-process singletons for the local app: the sync engine, the team service and the event bus the browser listens to.
 * They exist only for a signed-in (non-demo) profile; demo mode never contacts GitHub.
 */

type G = typeof globalThis & { __mp?: { bus: EventEmitter; engine?: SyncEngine; team?: TeamService; hub?: { key: string; svc: HubTeamService }; version: number } };
const g = globalThis as G;
const state = (g.__mp ??= { bus: new EventEmitter(), version: 0 });
state.bus.setMaxListeners(50);

export const bus = state.bus;
/** Monotonic counter bumped on every data change; the browser compares it to know when to refresh. */
export const dataVersion = () => state.version;

/** Tells the open page that something changed (a background refresh finished, a pull landed). */
export function notifyChange(reason: "pulled" | "pushed" | "state" = "state") {
  state.version++;
  // A burst (a sync finishing dozens of jobs) becomes one event per second: every event makes each open page re-render on the
  // server, so unthrottled bursts would keep the app busy refreshing itself.
  if (reason === "state") {
    if (throttle.timer) return void (throttle.pending = true);
    throttle.timer = setTimeout(() => {
      throttle.timer = undefined;
      if (throttle.pending) {
        throttle.pending = false;
        state.bus.emit("change", { version: state.version, spaceId: "", reason });
      }
    }, 1000);
    throttle.timer.unref?.();
  }
  state.bus.emit("change", { version: state.version, spaceId: "", reason });
}
const throttle: { timer?: ReturnType<typeof setTimeout>; pending: boolean } = { pending: false };

export async function localActor() {
  const user = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  return user ? { id: user.githubId, login: user.login } : null;
}

export async function getEngine(): Promise<SyncEngine | null> {
  if (isDemo()) return null;
  if (state.engine) return state.engine;
  const actor = await localActor();
  if (!actor) return null;
  const f = ghFetch(profileRunner(db));
  state.engine = new SyncEngine({
    db,
    actor,
    store: (s: Space) => new CoordinationStore(new GitHubRest(f), s.repoOwner, s.repoName),
    onChange: (e) => {
      state.version++;
      state.bus.emit("change", { version: state.version, ...e });
    },
  });
  return state.engine;
}

export async function getTeamService(): Promise<TeamService | null> {
  if (isDemo()) return null;
  if (state.team) return state.team;
  const actor = await localActor();
  if (!actor) return null;
  state.team = new TeamService(db, ghFetch(profileRunner(db)), actor, await getEngine());
  return state.team;
}

/**
 * Team administration for a hub profile. The hub origin comes from the known-servers list entry for the active backend; the
 * session token is read per call, so signing out or in again is picked up at once. One instance per session account, because
 * the service caches what the hub last said about the actor.
 */
export async function getHubTeamService(backend: string): Promise<{ svc: HubTeamService; dbFile: string; origin: string | null }> {
  const dbFile = resolveDbFile();
  const entry = readHubs(mergeportHome(env().MERGEPORT_HOME)).find((h) => {
    try {
      return hubBackendId(h.origin) === backend;
    } catch {
      return false;
    }
  });
  const origin = entry?.origin ?? null;
  const session = await hubSessionPort.read(dbFile);
  const key = `${backend}:${session?.githubId ?? ""}`;
  if (state.hub?.key !== key) {
    // With no known origin or session every call fails as "sign in again" (HubUnauthorized) before any request is made.
    state.hub = { key, svc: new HubTeamService(httpHubAdmin(origin ?? "http://127.0.0.1:0", async () => (origin ? ((await hubSessionPort.read(dbFile))?.token ?? null) : null)), session?.githubId ?? "") };
  }
  return { svc: state.hub.svc, dbFile, origin };
}

export const resetRuntime = () => {
  state.engine = undefined;
  state.team = undefined;
  state.hub = undefined;
};

/**
 * Sends local edits to the team spaces soon after they are made, instead of waiting for the next poll. Called after every
 * successful action; a burst of edits becomes one cycle a moment later. It never blocks the action and never throws.
 */
const soon: { timer?: ReturnType<typeof setTimeout> } = {};
export function syncSoon(delayMs = 1200) {
  if (process.env.VITEST || soon.timer) return;
  soon.timer = setTimeout(async () => {
    soon.timer = undefined;
    try {
      const engine = await getEngine();
      if (!engine) return;
      for (const space of await db.space.findMany({ where: { access: "OK" } })) await engine.syncSpace(space).catch(() => {});
    } catch {
      // the regular poll will retry
    }
  }, delayMs);
  soon.timer.unref?.();
}
