import { isHosted } from "@/lib/public-url";
import { EventEmitter } from "node:events";
import type { Space } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { profileFetch } from "@/lib/local/profile-runner";
import { GitHubRest } from "@/lib/github/rest";
import { SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { TeamService } from "@/lib/team/service";
import { firstWorkspace } from "@/lib/local/profile";

/**
 * Per-process singletons for the local app: the sync engine, the team service, the hub live link and the event bus the
 * browser listens to. They exist only for a signed-in (non-demo) profile; demo mode never contacts GitHub or a hub.
 */

type G = typeof globalThis & { __mp?: { bus: EventEmitter; engines: Map<string, SyncEngine>; enginePromises: Map<string, Promise<SyncEngine | null>>; teams: Map<string, TeamService>; version: number } };
const g = globalThis as G;
const state: NonNullable<G["__mp"]> = (g.__mp ??= { bus: new EventEmitter(), engines: new Map(), enginePromises: new Map(), teams: new Map(), version: 0 });
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
  if (isHosted()) return null; // the server's gh login is not any workspace's credential
  const user = await db.user.findFirst({ where: { isDemo: false, githubId: { not: null } }, orderBy: { createdAt: "asc" } });
  return user && user.githubId !== null ? { id: user.githubId, login: user.login } : null;
}

/**
 * Builds the engine for this profile: the GitHub coordination store.
 */
export async function getEngine(workspaceId?: string): Promise<SyncEngine | null> {
  if (isDemo()) return null;
  const ws = workspaceId ?? (await firstWorkspace(db)).id; // fails closed when several workspaces exist and the caller named none
  const have = state.engines.get(ws);
  if (have) return have;
  // Concurrent first callers (the scheduler's first tick and a page render) share one build. Two engines would each keep their own
  // "cycle in progress" set, and the live link would drive a different engine than the pages and the Sync button use.
  let building = state.enginePromises.get(ws);
  if (!building) {
    building = buildEngine(ws).then(
      (e) => {
        if (!e) state.enginePromises.delete(ws); // no signed-in account yet: ask again next time
        return e;
      },
      (err) => {
        state.enginePromises.delete(ws);
        throw err;
      },
    );
    state.enginePromises.set(ws, building);
  }
  return building;
}

async function buildEngine(workspaceId: string): Promise<SyncEngine | null> {
  const actor = await localActor();
  if (!actor) return null;
  const f = profileFetch(db);
  const onChange = (e: { spaceId: string; reason: "pulled" | "pushed" | "state" }) => {
    state.version++;
    state.bus.emit("change", { version: state.version, ...e });
  };
  const engine = new SyncEngine({
    workspaceId,
    db,
    actor,
    store: (s: Space) => new CoordinationStore(new GitHubRest(f), s.repoOwner, s.repoName),
    onChange,
  });
  state.engines.set(workspaceId, engine);
  return engine;
}

export async function getTeamService(workspaceId?: string): Promise<TeamService | null> {
  if (isDemo()) return null;
  const ws = workspaceId ?? (await firstWorkspace(db)).id;
  const have = state.teams.get(ws);
  if (have) return have;
  const actor = await localActor();
  if (!actor) return null;
  const svc = new TeamService(db, profileFetch(db), actor, await getEngine(ws), undefined, ws);
  state.teams.set(ws, svc);
  return svc;
}

export const resetRuntime = () => {
  state.engines.clear();
  state.enginePromises.clear();
  state.teams.clear();
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
      for (const space of await db.space.findMany({ where: { workspaceId: (await firstWorkspace(db)).id, access: "OK" } })) await engine.syncSpace(space).catch(() => {});
    } catch {
      // the regular poll will retry
    }
  }, delayMs);
  soon.timer.unref?.();
}
