import { wsId } from "./helpers";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { syncHubSpaces } from "@/lib/hub/spaces";
import { BackendMismatchError } from "@/lib/local/backend-guard";
import { hubBackendId, type Backend } from "@/lib/local/backends";
import { SyncEngine } from "@/lib/sync/engine";
import { TeamService } from "@/lib/team/service";

const db = createTestPrisma(path.resolve(".data", `backend-guard-wiring-${process.pid}.db`));
afterAll(() => db.$disconnect());

const base = { remoteId: "r", teamRemoteId: "t", kind: "COMMON" as const, name: "n" };
const actor = { id: 1n, login: "alice" };
const HUB = hubBackendId("https://hub.example.com");

/** Every way the engine reaches the network goes through `store` or `hub`; both are counted. */
function engine(profileBackend: Backend) {
  const store = vi.fn(() => {
    throw new Error("store called");
  });
  const hub = vi.fn(() => ({}) as never);
  const events: string[] = [];
  const e = new SyncEngine({ db, store: store as never, actor, hub, profileBackend, onChange: (x) => events.push(x.reason) });
  return { e, store, hub, events };
}

let n = 0;
const githubSpace = async () => db.space.create({ data: { workspaceId: await wsId(db), ...base, remoteId: `g${n}`, repoOwner: "acme", repoName: `guard-${n++}` } });
const hubSpace = async () => db.space.create({ data: { workspaceId: await wsId(db), ...base, remoteId: `h${n}`, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: `guard-${n++}` } });

describe("backend isolation guard wired into the engine", () => {
  it("a GITHUB space in a hub profile is refused before any network call", async () => {
    const space = await githubSpace();
    const { e, store, hub } = engine(HUB);
    await expect(e.pullSpace(space)).rejects.toBeInstanceOf(BackendMismatchError);
    await expect(e.pushSpace(space)).rejects.toBeInstanceOf(BackendMismatchError);
    expect(store).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("a HUB space in a GitHub profile is refused before any network call", async () => {
    const space = await hubSpace();
    const { e, store, hub } = engine("github");
    await expect(e.pullSpace(space)).rejects.toBeInstanceOf(BackendMismatchError);
    await expect(e.pushSpace(space)).rejects.toBeInstanceOf(BackendMismatchError);
    expect(store).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("matching backends proceed to their own client", async () => {
    const g = engine("github");
    await expect(g.e.pullSpace(await githubSpace())).rejects.toThrow(/store called/);
    expect(g.store).toHaveBeenCalled();
    const h = engine(HUB);
    expect(await h.e.pullSpace(await hubSpace())).toEqual({ changed: false, applied: 0 });
    expect(h.hub).toHaveBeenCalled();
    expect(h.store).not.toHaveBeenCalled();
  });

  it("syncSpace and tick record the mismatch as the space's sync error, without throwing or hot-looping", async () => {
    await db.space.deleteMany(); // tick polls every due space; only this one may exist
    const space = await hubSpace();
    const { e, store, hub, events } = engine("github");
    await expect(e.syncSpace(space)).resolves.toBeUndefined();
    const after = await db.space.findUniqueOrThrow({ where: { id: space.id } });
    expect(after.lastError).toMatch(/different kind of connection/);
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());
    expect(events).toContain("state");
    expect((await e.stateFor(after)).detail).toMatch(/different kind of connection/);
    await e.tick(); // not due: the refused space is not retried on the next tick
    expect(store).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("space creation and joining entry points refuse the other backend before any request", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network");
    });
    const team = new TeamService(db, fetch as never, actor, engine(HUB).e);
    await expect(team.createTeam({ owner: "alice", repoName: "x", teamName: "T" } as never, { confirmed: true })).rejects.toBeInstanceOf(BackendMismatchError);
    await expect(team.createRestrictedSpace({ name: "r" })).rejects.toBeInstanceOf(BackendMismatchError);
    await expect(team.join("acme/x", { confirmed: true })).rejects.toBeInstanceOf(BackendMismatchError);
    expect(fetch).not.toHaveBeenCalled();
    const before = await db.space.count({ where: { backend: "HUB" } });
    await expect(syncHubSpaces(db, engine("github").e, { team: { id: "t" }, spaces: [{ id: "new", kind: "COMMON", name: "c", canWrite: true }] } as never)).rejects.toBeInstanceOf(BackendMismatchError);
    expect(await db.space.count({ where: { backend: "HUB" } })).toBe(before);
  });
});
