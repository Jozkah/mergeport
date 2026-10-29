import type { Db } from "@/lib/db";
import type { SyncEngine } from "@/lib/sync/engine";
import type { HubClient } from "./types";
import { HubLink, defaultTimers, type HubLinkState, type SocketLike, type Timers } from "./link";
import { syncHubSpaces } from "./spaces";

const FALLBACK_POLL_MS = 60_000;

export type HubLiveOptions = {
  db: Db;
  engine: SyncEngine;
  client: HubClient;
  origin: string;
  getToken: () => Promise<string | null>;
  connect?: (url: string, protocols: string[]) => SocketLike;
  timers?: Timers;
  random?: () => number;
};

/**
 * Wires a HubLink to the engine. Hub spaces are driven by the socket while it is live; otherwise a 60 s poll
 * keeps them fresh. The engine's `hubLive` dep must read `live()` so its own tick() leaves hub spaces alone.
 */
export function startHubLive(o: HubLiveOptions): { link: HubLink; live(): boolean; stop(): void } {
  const timers = o.timers ?? defaultTimers;
  let stopped = false;
  let poll: unknown = null;

  // One cycle per space at a time; a notification that arrives mid-cycle schedules exactly one more.
  const inflight = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const syncOne = (spaceId: string): Promise<void> => {
    const running = inflight.get(spaceId);
    if (running) {
      dirty.add(spaceId);
      return running;
    }
    const p = (async () => {
      try {
        do {
          dirty.delete(spaceId);
          const sp = await o.db.space.findUnique({ where: { id: spaceId } });
          if (!sp || sp.backend !== "HUB" || sp.access === "REVOKED") return;
          await o.engine.syncSpace(sp);
        } while (dirty.has(spaceId));
      } catch {
        // recorded on the space by the engine; the fallback poll retries
      } finally {
        inflight.delete(spaceId);
      }
    })();
    inflight.set(spaceId, p);
    return p;
  };
  const syncAll = async () => {
    const spaces = await o.db.space.findMany({ where: { backend: "HUB" } });
    await Promise.all(spaces.map((s) => syncOne(s.id)));
  };

  // me() + syncHubSpaces, serialised so two notifications never race to create the same Space row.
  let queue: Promise<void> = Promise.resolve();
  const refresh = (): Promise<void> => {
    const run = async () => {
      try {
        await syncHubSpaces(o.db, o.engine, await o.client.me());
      } catch {
        // a failing me() must not stop the spaces from syncing; the cycle records the failure
      }
    };
    return (queue = queue.then(run, run));
  };
  const refreshAndSyncAll = async () => {
    await refresh();
    await syncAll();
  };

  const byHubId = (hubSpaceId: string) => o.db.space.findFirst({ where: { backend: "HUB", hubSpaceId } });
  const revoke = async (hubSpaceId: string) => {
    const sp = await byHubId(hubSpaceId);
    if (sp && sp.access !== "REVOKED") await o.engine.revokeSpace(sp.id, "You no longer have access to this space");
  };
  const revokeAll = async () => {
    for (const s of await o.db.space.findMany({ where: { backend: "HUB" } })) {
      if (s.access !== "REVOKED") await o.engine.revokeSpace(s.id, "You were removed from this server");
    }
  };

  const link: HubLink = new HubLink({
    origin: o.origin,
    getToken: o.getToken,
    connect: o.connect,
    timers: o.timers,
    random: o.random,
    onHello: () => void refreshAndSyncAll().catch(() => {}),
    onChanged: (hubSpaceId, seq) => {
      void (async () => {
        let sp = await byHubId(hubSpaceId);
        if (!sp) {
          await refresh();
          sp = await byHubId(hubSpaceId);
        }
        if (!sp || sp.access === "REVOKED" || sp.hubCursor >= seq) return;
        await syncOne(sp.id);
      })().catch(() => {});
    },
    onAccess: (hubSpaceId, action) => {
      void (async () => {
        if (action === "added") {
          await refresh();
          const sp = await byHubId(hubSpaceId);
          if (sp) await syncOne(sp.id);
        } else await revoke(hubSpaceId);
      })().catch(() => {});
    },
    onTeam: () => void refresh().catch(() => {}),
    onState: (s: HubLinkState) => {
      if (s === "removed") void revokeAll().catch(() => {});
      if (s === "live" || s === "removed") stopPoll();
      else startPoll();
    },
  });

  function startPoll() {
    if (stopped || poll !== null) return;
    poll = timers.setInterval(() => {
      if (!stopped && link.state !== "live") void refreshAndSyncAll().catch(() => {});
    }, FALLBACK_POLL_MS);
  }
  function stopPoll() {
    if (poll !== null) timers.clearInterval(poll);
    poll = null;
  }

  startPoll();
  link.start();
  return {
    link,
    live: () => link.state === "live",
    stop: () => {
      stopped = true;
      stopPoll();
      link.stop();
    },
  };
}
