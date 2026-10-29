import { afterEach, describe, expect, it } from "vitest";
import { ControlClient, Supervisor, type ChildHandle, type ChildSpec, type SupervisorDeps } from "@/lib/local/supervisor";
import type { Backend } from "@/lib/local/backends";

const HUB: Backend = "hub-0123456789abcdef";

function makeDeps(opts: { failReadyFor?: (spec: ChildSpec) => boolean; resolve?: (b: Backend) => string } = {}) {
  const spawned: ChildSpec[] = [];
  const exits: Array<(code: number | null) => void> = [];
  let live = 0;
  let maxLive = 0;
  const events: string[] = [];
  let n = 0;
  const deps: SupervisorDeps = {
    spawnChild(spec) {
      spawned.push(spec);
      live++;
      maxLive = Math.max(maxLive, live);
      events.push(`spawn:${spec.dbFile}`);
      let cb: ((code: number | null) => void) | undefined;
      let dead = false;
      const die = (code: number | null) => {
        if (dead) return;
        dead = true;
        live--;
        cb?.(code);
      };
      exits.push(die);
      const handle: ChildHandle = {
        async kill() {
          events.push(`kill:${spec.dbFile}`);
          die(null);
        },
        onExit(f) {
          cb = f;
        },
      };
      return handle;
    },
    async waitReady() {
      const spec = spawned[spawned.length - 1];
      if (opts.failReadyFor?.(spec)) throw new Error("boom");
      return `boot-${spawned.length}`;
    },
    async resolveTarget({ backend }) {
      return { dbFile: opts.resolve ? opts.resolve(backend) : `/db/${backend}` };
    },
    newToken: () => `tok-${++n}`,
  };
  return { deps, spawned, exits, events, maxLive: () => maxLive };
}

const sups: Supervisor[] = [];
function sup(deps: SupervisorDeps) {
  const s = new Supervisor(deps, { port: 4100, demo: false });
  sups.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(sups.splice(0).map((s) => s.stop()));
});

describe("Supervisor", () => {
  it("kills child A before spawning B, with a new token and the resolved db", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    const r = await s.switchTo({ backend: HUB });
    expect(f.events).toEqual(["spawn:/db/a", "kill:/db/a", `spawn:/db/${HUB}`]);
    expect(f.spawned[1].token).not.toBe(f.spawned[0].token);
    expect(f.spawned[1].dbFile).toBe(`/db/${HUB}`);
    expect(r.launchUrl).toBe(`http://127.0.0.1:4100/api/local/launch?token=${f.spawned[1].token}`);
  });

  it("coalesces concurrent switches into one extra spawn", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    const [x, y] = await Promise.all([s.switchTo({ backend: HUB }), s.switchTo({ backend: HUB })]);
    expect(f.spawned).toHaveLength(2);
    expect(y).toEqual(x);
  });

  it("never has more than one live child", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    await s.switchTo({ backend: HUB });
    await s.switchTo({ backend: "github" });
    await s.switchTo({ backend: HUB });
    expect(f.spawned).toHaveLength(4);
    expect(f.maxLive()).toBe(1);
  });

  it("restores the previous child when the new one never gets ready", async () => {
    const f = makeDeps({ failReadyFor: (spec) => spec.dbFile === `/db/${HUB}` });
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    await expect(s.switchTo({ backend: HUB })).rejects.toThrow("Could not start the other workspace; the previous one was restored");
    expect(f.spawned).toHaveLength(3);
    expect(f.spawned[2]).toEqual(f.spawned[0]);
    expect(f.maxLive()).toBe(1);
  });

  it("refuses a different switch mid-flight and leaves spawns unchanged", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    const first = s.switchTo({ backend: HUB });
    await expect(s.switchTo({ backend: "github" })).rejects.toThrow("Another workspace switch is in progress");
    await first;
    expect(f.spawned).toHaveLength(2);
  });

  it("refuses start() while a switch is in flight", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    const first = s.switchTo({ backend: HUB });
    await expect(s.start({ dbFile: "/db/x" })).rejects.toThrow("Another workspace switch is in progress");
    await first;
    expect(f.spawned).toHaveLength(2);
  });

  it("reports when the previous child cannot be restored either", async () => {
    const f = makeDeps({ failReadyFor: () => f.spawned.length >= 2 });
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    await expect(s.switchTo({ backend: HUB })).rejects.toThrow("Could not start the other workspace, and the previous one could not be restored");
    expect(f.spawned).toHaveLength(3);
    expect(f.maxLive()).toBe(1);
    expect(f.events[f.events.length - 1]).toBe("kill:/db/a");
  });

  it("does not emit child-exit for a child dying during a switch's boot", async () => {
    const f = makeDeps({ failReadyFor: (spec) => spec.dbFile === `/db/${HUB}` });
    const s = sup(f.deps);
    const codes: Array<number | null> = [];
    s.on("child-exit", (c) => codes.push(c));
    await s.start({ dbFile: "/db/a" });
    f.deps.waitReady = async () => {
      f.exits[f.exits.length - 1](1);
      throw new Error("died");
    };
    await expect(s.switchTo({ backend: HUB })).rejects.toThrow();
    expect(codes).toEqual([]);
  });

  it("emits child-exit for an unexpected exit and does not respawn", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    const codes: Array<number | null> = [];
    s.on("child-exit", (c) => codes.push(c));
    await s.start({ dbFile: "/db/a" });
    f.exits[0](7);
    expect(codes).toEqual([7]);
    expect(f.spawned).toHaveLength(1);
  });

  it("does not emit child-exit for the kill during a switch", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    const codes: Array<number | null> = [];
    s.on("child-exit", (c) => codes.push(c));
    await s.start({ dbFile: "/db/a" });
    await s.switchTo({ backend: HUB });
    expect(codes).toEqual([]);
  });
});

describe("control channel", () => {
  async function control(resolve?: (b: Backend) => string) {
    const f = makeDeps({ resolve });
    const s = sup(f.deps);
    await s.start({ dbFile: "/db/a" });
    const { url, secret } = await s.listenControl();
    return { f, url, secret };
  }
  const post = (url: string, body: unknown, secret?: string) =>
    fetch(`${url}/switch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-mergeport-control": secret } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects a wrong or missing secret with 401", async () => {
    const { url } = await control();
    expect((await post(url, { backend: HUB }, "wrong")).status).toBe(401);
    expect((await post(url, { backend: HUB })).status).toBe(401);
  });

  it("rejects a bad body with 400", async () => {
    const { url, secret } = await control();
    expect((await post(url, { backend: "nope" }, secret)).status).toBe(400);
    expect((await post(url, "{not json", secret)).status).toBe(400);
  });

  it("answers 409 when the target is unavailable", async () => {
    const { url, secret } = await control(() => {
      throw new Error("No such workspace");
    });
    const res = await post(url, { backend: HUB }, secret);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No such workspace" });
  });

  it("answers 200 with the launch url once the child is ready", async () => {
    const { f, url, secret } = await control();
    const res = await post(url, { backend: HUB }, secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ launchUrl: `http://127.0.0.1:4100/api/local/launch?token=${f.spawned[1].token}` });
  });

  it("answers 413 for an oversized body", async () => {
    const { url, secret } = await control();
    expect((await post(url, JSON.stringify({ backend: HUB, pad: "x".repeat(5000) }), secret)).status).toBe(413);
  });

  it("answers 409 for a different switch mid-flight", async () => {
    const { f, url, secret } = await control();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = f.deps.waitReady;
    f.deps.waitReady = async (...args) => {
      await gate;
      return ready(...args);
    };
    const first = post(url, { backend: HUB }, secret);
    await new Promise((r) => setTimeout(r, 30));
    const second = await post(url, { backend: "github" }, secret);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("refuses a second listenControl", async () => {
    const f = makeDeps();
    const s = sup(f.deps);
    await s.listenControl();
    await expect(s.listenControl()).rejects.toThrow();
  });

  it("ControlClient switches and surfaces errors", async () => {
    const { url, secret } = await control();
    const ok = await new ControlClient(url, secret).switchTo(HUB);
    expect(ok.launchUrl).toContain("/api/local/launch?token=");
    await expect(new ControlClient(url, "wrong").switchTo(HUB)).rejects.toThrow();
  });
});
