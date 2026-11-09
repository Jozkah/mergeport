import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLink, type SocketLike } from "@/lib/hub/link";
import { HUB_COVERAGE_KEY } from "@/lib/hub/webhook-panel";
import { readHubCoverage } from "@/lib/hub/github-app-install";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { FakeHub, type FakeSocket } from "./fake-hub";
import { makeHubClient, type HubTestClient } from "./harness";
import { ManualTimers } from "./manual-timers";

class ScriptSocket implements SocketLike {
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  send() {}
  close() {}
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("HubLink: covered", () => {
  async function open(onCovered: (ids: string[]) => void) {
    let s!: ScriptSocket;
    const link = new HubLink({ origin: "https://hub.example.com", getToken: async () => "t", connect: () => (s = new ScriptSocket()), timers: new ManualTimers(), onChanged() {}, onAccess() {}, onTeam() {}, onCovered });
    link.start();
    await flush();
    return s;
  }

  it("hands a covered list to onCovered", async () => {
    const got: string[][] = [];
    const s = await open((ids) => got.push(ids));
    s.msg({ t: "covered", repos: ["1", "22"] });
    s.msg({ t: "covered", repos: [] });
    expect(got).toEqual([["1", "22"], []]);
  });

  it("ignores malformed covered messages and never throws", async () => {
    const got: string[][] = [];
    const s = await open((ids) => got.push(ids));
    for (const bad of [{ t: "covered" }, { t: "covered", repos: "1" }, { t: "covered", repos: [1] }, { t: "covered", repos: ["a"] }, { t: "covered", repos: ["1", null] }, { t: "covered", repos: { 0: "1" } }, { t: "covered", repos: ["-1"] }]) {
      expect(() => s.msg(bad)).not.toThrow();
    }
    s.msg({ t: "covered", repos: ["5"] });
    expect(got).toEqual([["5"]]);
  });

  it("an onCovered that throws never throws out of onmessage", async () => {
    const s = await open(() => {
      throw new Error("boom");
    });
    expect(() => s.msg({ t: "covered", repos: ["1"] })).not.toThrow();
  });

  it("a link without onCovered ignores the message", async () => {
    let s!: ScriptSocket;
    new HubLink({ origin: "https://hub.example.com", getToken: async () => "t", connect: () => (s = new ScriptSocket()), timers: new ManualTimers(), onChanged() {}, onAccess() {}, onTeam() {} }).start();
    await flush();
    expect(() => s.msg({ t: "covered", repos: ["1"] })).not.toThrow();
  });
});

const meta = (id: bigint, name: string): RepoMeta => ({
  githubId: id, fullName: `octo-org/${name}`, name, htmlUrl: `https://github.com/octo-org/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: 583231n, login: "octo-org", type: "ORGANIZATION" },
});

describe("the live link: covered", () => {
  let hub: FakeHub;
  let c: HubTestClient;
  let timers: ManualTimers;
  let states: number;

  beforeEach(async () => {
    hub = new FakeHub();
    hub.addMember("2", "alice", "MEMBER");
    hub.createSpace("common", "COMMON", "Common");
    await hub.listen();
    c = await makeHubClient(hub, 2n, "alice");
    timers = new ManualTimers();
    states = 0;
  });
  afterEach(async () => {
    await c.close();
    await hub.close();
  });
  const sock = (): FakeSocket => [...hub.sockets][0];
  const start = () => c.startLive({ timers, notifyState: () => void states++ });

  it("saves the set the hub reports under github-app-hub-coverage and emits a state change; later reports replace it", async () => {
    await upsertRepository(c.db, c.profile.workspace.id, meta(1296269n, "hello-world"));
    await upsertRepository(c.db, c.profile.workspace.id, meta(42n, "other"));
    hub.setCovered(["42", "999"]); // 999 is not watched: the hub never reports it
    start();
    await vi.waitFor(() => expect(states).toBe(1));
    const row = await c.db.discoveryCache.findUnique({ where: { key: HUB_COVERAGE_KEY } });
    const saved = row?.payload as unknown as { ids: string[]; at: string };
    expect(saved.ids).toEqual(["42"]);
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
    expect([...(await readHubCoverage(c.db))]).toEqual(["42"]);

    hub.setCovered(["42", "1296269"]);
    await vi.waitFor(() => expect(states).toBe(2));
    expect([...(await readHubCoverage(c.db))].sort()).toEqual(["1296269", "42"]);
    hub.setCovered(["42", "1296269"]); // unchanged: the hub sends nothing
    await new Promise((r) => setTimeout(r, 30));
    expect(states).toBe(2);
    expect(sock()).toBeDefined();
  });
});
