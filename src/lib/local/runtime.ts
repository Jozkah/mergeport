import { isHosted } from "@/lib/public-url";
import { EventEmitter } from "node:events";
import type { Space } from "@/generated/prisma/client";
import { db, resolveDbFile } from "@/lib/db";
import { HttpHubClient } from "@/lib/hub/client";
import { startHubLive } from "@/lib/hub/live";
import { refreshHubWatch } from "@/lib/hub/watch";
import { loadHubSession, openVault } from "@/lib/hub/session-vault";
import { isDemo } from "@/lib/env";
import { profileFetch } from "@/lib/local/profile-runner";
import { GitHubRest } from "@/lib/github/rest";
import { SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { TeamService } from "@/lib/team/service";
import { HubTeamService } from "@/lib/team/hub-service";
import { httpHubAdmin, hubSessionPort, keyFileFor, registerHubLinkState } from "@/lib/hub/ports-impl";
import { GITHUB_BACKEND, hubBackendId, isHubBackend, type Backend } from "@/lib/local/backends";
import { firstWorkspace, mergeportHome } from "@/lib/local/profile";
import { readHubs } from "@/lib/local/registry";
import { env } from "@/lib/env";

/**
 * Per-process singletons for the local app: the sync engine, the team service, the hub live link and the event bus the
 * browser listens to. They exist only for a signed-in (non-demo) profile; demo mode never contacts GitHub or a hub.
 */

type HubLive = ReturnType<typeof startHubLive>;
type G = typeof globalThis & { __mp?: { bus: EventEmitter; engines: Map<string, SyncEngine>; enginePromises: Map<string, Promise<SyncEngine | null>>; teams: Map<string, TeamService>; hub?: { key: string; svc: HubTeamService }; live?: HubLive; version: number } };
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

/** The hub session token of this profile, decrypted per call so a sign-out or a new sign-in is picked up at once. */
const hubToken = async (): Promise<string | null> => (await loadHubSession(db, openVault(keyFileFor(resolveDbFile()))))?.token ?? null;

/**
 * Builds the engine for this profile's backend. A GitHub profile gets the GitHub store exactly as before. A hub profile
 * (`TeamConfig.backend = HUB` with an origin) gets an `HttpHubClient` and the live link, started once per process;
 * `hubLive` lets the engine's own tick leave hub spaces to the socket while it is up.
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
  const team = await db.teamConfig.findUnique({ where: { workspaceId } });
  const hubOrigin = team?.backend === "HUB" ? team.hubOrigin : null;
  // The launcher's MERGEPORT_BACKEND names what this profile directory is; without a launcher, TeamConfig decides.
  const launched = process.env.MERGEPORT_BACKEND;
  const profileBackend = launched === GITHUB_BACKEND || (launched && isHubBackend(launched)) ? (launched as Backend) : hubOrigin ? hubBackendId(hubOrigin) : GITHUB_BACKEND;
  if (!hubOrigin) {
    const plain = new SyncEngine({
      workspaceId,
      db,
      actor,
      profileBackend,
      store: (s: Space) => new CoordinationStore(new GitHubRest(f), s.repoOwner, s.repoName),
      onChange,
    });
    state.engines.set(workspaceId, plain);
    return plain;
  }
  // The hub link (session, live socket, watch set) is one per process. FAIL CLOSED: it never starts when there are several workspaces.
  if ((await firstWorkspace(db)).id !== workspaceId) throw new Error("The hub link serves the profile's only workspace.");
  const client = new HttpHubClient(hubOrigin, hubToken);
  const engine = new SyncEngine({
      workspaceId,
    db,
    actor,
    store: (s: Space) => new CoordinationStore(new GitHubRest(f), s.repoOwner, s.repoName),
    hub: () => client,
    profileBackend,
    hubLive: () => state.live?.live() ?? false,
    onChange,
  });
  state.engines.set(workspaceId, engine);
  if (!state.live) {
    state.live = startHubLive({ db, engine, client, origin: hubOrigin, getToken: hubToken, notify: () => notifyChange("pulled"), notifyState: () => notifyChange("state"), kickJobs: () => void import("@/lib/local/scheduler").then((m) => m.runJobsNow()).catch(() => {}) });
    registerHubLinkState(() => state.live?.link.state ?? "offline");
  }
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

/**
 * Team administration for a hub profile. The hub origin is the one on TeamConfig, else the known-servers list entry for the
 * active backend; the session token is read per call, so signing out or in again is picked up at once. One instance per
 * session account, because the service caches what the hub last said about the actor.
 */
export async function getHubTeamService(backend: string): Promise<{ svc: HubTeamService; dbFile: string; origin: string | null }> {
  const dbFile = resolveDbFile();
  const team = await db.teamConfig.findUnique({ where: { workspaceId: (await firstWorkspace(db)).id } });
  const entry = readHubs(mergeportHome(env().MERGEPORT_HOME)).find((h) => {
    try {
      return hubBackendId(h.origin) === backend;
    } catch {
      return false;
    }
  });
  const origin = (team?.backend === "HUB" && team.hubOrigin) || entry?.origin || null;
  const session = await hubSessionPort.read(dbFile);
  const key = `${backend}:${session?.githubId ?? ""}`;
  if (state.hub?.key !== key) {
    // With no known origin or session every call fails as "sign in again" (HubUnauthorized) before any request is made.
    state.hub = { key, svc: new HubTeamService(httpHubAdmin(origin ?? "http://127.0.0.1:0", async () => (origin ? ((await hubSessionPort.read(dbFile))?.token ?? null) : null)), session?.githubId ?? "") };
  }
  return { svc: state.hub.svc, dbFile, origin };
}

/**
 * Tells the hub which repositories this profile tracks (ACTIVE ones), after tracking, untracking or a status change. A no-op in GitHub-only mode. */
export { refreshHubWatch };

export const resetRuntime = () => {
  state.live?.stop();
  state.live = undefined;
  registerHubLinkState(null);
  state.engines.clear();
  state.enginePromises.clear();
  state.teams.clear();
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
      for (const space of await db.space.findMany({ where: { workspaceId: (await firstWorkspace(db)).id, access: "OK" } })) await engine.syncSpace(space).catch(() => {});
    } catch {
      // the regular poll will retry
    }
  }, delayMs);
  soon.timer.unref?.();
}
