import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpHubClient, checkHubHealth, normalizeHubOrigin } from "@/lib/hub/client";
import { HubError, type Op } from "@/lib/hub/types";
import { FakeHub } from "./fake-hub";

describe("normalizeHubOrigin", () => {
  it("lowercases host and drops path", () => {
    expect(normalizeHubOrigin("https://Hub.Example.com/x/")).toBe("https://hub.example.com");
  });
  it("rejects plain http except loopback", () => {
    expect(() => normalizeHubOrigin("http://hub.example.com")).toThrow(HubError);
    expect(normalizeHubOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeHubOrigin("http://localhost:1")).toBe("http://localhost:1");
    expect(normalizeHubOrigin("http://[::1]:1")).toBe("http://[::1]:1");
  });
});

const op = (opId: string, baseVersion: number, data: Record<string, unknown> = { title: "a" }): Op => ({ opId, type: "task", entityId: "t1", kind: "UPSERT", baseVersion, data });

describe("HttpHubClient against FakeHub", () => {
  let hub: FakeHub;
  let url: string;
  let token: string | null;
  let client: HttpHubClient;
  beforeEach(async () => {
    hub = new FakeHub();
    hub.addMember("1", "alice", "ADMIN");
    hub.createSpace("common", "COMMON", "Common");
    token = hub.token("1");
    url = (await hub.listen()).url;
    client = new HttpHubClient(url, async () => token);
  });
  afterEach(async () => {
    await hub.close();
  });

  it("me lists spaces with parsed seq", async () => {
    const me = await client.me();
    expect(me.member.login).toBe("alice");
    expect(me.spaces[0]).toMatchObject({ id: "common", canWrite: true, seq: "0" });
  });

  it("push applies, duplicates and goes stale", async () => {
    const r1 = await client.push("common", [op("o1", 0)]);
    expect(r1.results[0]).toMatchObject({ status: "applied", version: 1 });
    expect(r1.seq).toBe(1n);
    const r2 = await client.push("common", [op("o1", 0)]);
    expect(r2.results[0].status).toBe("duplicate");
    const r3 = await client.push("common", [op("o2", 0, { title: "b" })]);
    expect(r3.results[0].status).toBe("stale");
    expect(r3.results[0].current?.version).toBe(1);
  });

  it("pull returns events with bigint seq, gone after prune", async () => {
    await client.push("common", [op("o1", 0)]);
    const p = await client.pull("common", 0n);
    if (p === "gone") throw new Error("unexpected gone");
    expect(p.seq).toBe(1n);
    expect(p.events[0].seq).toBe(1n);
    expect(p.events[0].opId).toBe("o1");
    await client.push("common", [op("o2", 1, { title: "c" })]);
    hub.pruneBefore(2n);
    expect(await client.pull("common", 0n)).toBe("gone");
    expect(await client.pull("common", 2n)).toMatchObject({ seq: 2n, events: [] });
    const snap = await client.snapshot("common");
    expect(snap.seq).toBe(2n);
    expect(snap.entities[0].version).toBe(2);
  });

  it("maps errors", async () => {
    token = null;
    await expect(client.me()).rejects.toMatchObject({ kind: "auth" });
    token = "bogus";
    await expect(client.me()).rejects.toMatchObject({ kind: "auth" });
    token = hub.token("1");
    await expect(client.pull("nope", 0n)).rejects.toMatchObject({ kind: "not-found" });
    hub.removeMember("1");
    await expect(client.me()).rejects.toMatchObject({ kind: "forbidden" });
    await hub.close();
    await expect(client.me()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("checkHubHealth", () => {
  let hub: FakeHub;
  let url: string;
  beforeEach(async () => {
    hub = new FakeHub();
    url = (await hub.listen()).url;
  });
  afterEach(async () => {
    await hub.close();
  });
  it("accepts a good hub", async () => {
    expect(await checkHubHealth(url)).toMatchObject({ publicUrl: url, githubHost: "github.com" });
  });
  it("refuses newer schema, url mismatch, other github host", async () => {
    hub.setSchema(2);
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "schema" });
    hub.setSchema(1);
    hub.publicUrl = "https://elsewhere.example.com";
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "unknown" });
    hub.publicUrl = undefined;
    hub.githubHost = "ghe.example.com";
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "unknown" });
  });
});
