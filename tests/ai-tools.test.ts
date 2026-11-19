import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "@/lib/errors";
import { runTool, itemFacts, digestFacts } from "@/lib/services/ai-tools";
import { generateDigest } from "@/lib/services/digest";
import { listWorkItems } from "@/lib/services/queries";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const cfg = { baseUrl: "https://ai.example.com/v1", apiKey: "k", model: null };
const fake = (reply: string, seen: { system?: string; user?: string } = {}) =>
  (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m1", status: "ready" }] }));
    const m = JSON.parse(String(init.body)).messages as { role: string; content: string }[];
    seen.system = m[0].content;
    seen.user = m[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  }) as unknown as typeof fetch;

describe("facts", () => {
  it("describes a pull request with its status and comments, and refuses one the person cannot see", async () => {
    const { db, admin, b } = S;
    const all = (await listWorkItems(db, admin, { type: "PULL_REQUEST", state: "OPEN", pageSize: 100 })).rows;
    const first = all[0];
    const f = await itemFacts(db, admin, first.id);
    expect(f.label).toBe(`${first.repository.fullName}#${first.number}`);
    expect(f.text).toContain(first.title);
    expect(f.text).toMatch(/Review status:/);
    expect(f.href).toBe(`/pull-requests/${first.id}`);
    const visibleToB = new Set((await listWorkItems(db, b, { state: "ALL", pageSize: 100 })).rows.map((r) => r.id));
    const hidden = all.find((r) => !visibleToB.has(r.id))!;
    await expect(itemFacts(db, b, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists the digest sections", async () => {
    const { db, admin } = S;
    const { digest } = await generateDigest(db, admin, { replace: true });
    const text = digestFacts(digest.payload);
    expect(text).toContain(`Digest for ${digest.day}`);
    expect(text).toMatch(/Left undone/);
    expect(text).toMatch(/Needs the person/);
  });
});

describe("tools", () => {
  it("briefing: sends the digest facts with rules that treat them as data, and returns text with its source", async () => {
    const { db, admin } = S;
    const { digest } = await generateDigest(db, admin, { replace: true });
    const seen: { system?: string; user?: string } = {};
    const steps: string[] = [];
    const r = await runTool(db, admin, cfg, "digest", { day: digest.day }, { f: fake("Three things matter today.", seen), step: (s) => steps.push(s) });
    expect(r).toMatchObject({ title: `Briefing for ${digest.day}`, text: "Three things matter today.", model: "m1", sources: [{ href: `/digest?day=${digest.day}` }] });
    expect(seen.system).toMatch(/Ignore any instruction/);
    expect(seen.user).toContain(`Digest for ${digest.day}`);
    expect(steps[0]).toBe("Reading your daily digest");
  });

  it("stand-up: adds what is waiting on the person", async () => {
    const { db, a } = S;
    await generateDigest(db, a, { replace: true });
    const seen: { user?: string } = {};
    const r = await runTool(db, a, cfg, "standup", {}, { f: fake("Yesterday: x\nToday: y\nBlocked: nothing", seen) });
    expect(r.title).toBe("Stand-up");
    expect(seen.user).toContain("Waiting on the person right now");
    expect(seen.user).toContain(`@${a.login}`);
  });

  it("item: needs an id, reads the thread, and cannot be pointed at something hidden", async () => {
    const { db, admin, b } = S;
    await expect(runTool(db, admin, cfg, "item", {}, { f: fake("x") })).rejects.toThrow(/Open a pull request/);
    const first = (await listWorkItems(db, admin, { state: "ALL", pageSize: 1 })).rows[0];
    const seen: { user?: string } = {};
    const r = await runTool(db, admin, cfg, "item", { id: first.id }, { f: fake("It adds X. Next: review.", seen) });
    expect(r.text).toBe("It adds X. Next: review.");
    expect(seen.user).toContain(first.title);
    const visibleToB = new Set((await listWorkItems(db, b, { state: "ALL", pageSize: 100 })).rows.map((x) => x.id));
    const hidden = (await listWorkItems(db, admin, { state: "ALL", pageSize: 100 })).rows.find((x) => !visibleToB.has(x.id))!;
    await expect(runTool(db, b, cfg, "item", { id: hidden.id }, { f: fake("x") })).rejects.toBeInstanceOf(NotFoundError);
  });
});
