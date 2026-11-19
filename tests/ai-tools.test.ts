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

  it("focus: sends what is waiting on the person and asks for the first three things", async () => {
    const { db, a } = S;
    const seen: { system?: string; user?: string } = {};
    const r = await runTool(db, a, cfg, "focus", {}, { f: fake("First: review x.", seen) });
    expect(r).toMatchObject({ title: "What to do first", text: "First: review x." });
    expect(seen.system).toMatch(/at most three/);
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

describe("guiding the page", () => {
  it("turns the AI's steps into glowing links and ignores anything it invented", async () => {
    const { parseFocus } = await import("@/lib/services/ai-tools");
    const { buildSnapshot } = await import("@/lib/services/ai-review");
    const { db, a } = S;
    const snap = await buildSnapshot(db, a);
    const keys = [...snap.refs.keys()];
    expect(keys.length).toBeGreaterThan(1);
    const raw = JSON.stringify({ summary: " Start with the review. ", steps: [{ ref: keys[0].toLowerCase(), why: "Oldest." }, { ref: "R99", why: "invented" }, { ref: keys[0], why: "dup" }, { ref: keys[1], why: "Next." }, { ref: keys[2] ?? keys[1], why: "x" }, { ref: keys[3] ?? keys[0], why: "y" }] });
    const g = parseFocus(raw, snap)!;
    expect(g.summary).toBe("Start with the review.");
    expect(g.steps.length).toBeLessThanOrEqual(3);
    expect(g.steps[0]).toMatchObject({ label: snap.refs.get(keys[0])!.label, href: snap.refs.get(keys[0])!.href, why: "Oldest." });
    expect(g.steps[0].view).toMatch(/^\/attention\?queue=(needs-me|changes|blocked)$/);
    expect(new Set(g.steps.map((s) => s.href)).size).toBe(g.steps.length);
    expect(parseFocus("not json at all", snap)).toBeNull();
    expect(parseFocus(JSON.stringify({ steps: [] }), snap)).toBeNull(); // no summary: shown as plain text instead
  });

  it("focus returns steps when the model answers with JSON, and plain text when it does not", async () => {
    const { db, a } = S;
    const { buildSnapshot } = await import("@/lib/services/ai-review");
    const key = [...(await buildSnapshot(db, a)).refs.keys()][0];
    const json = await runTool(db, a, cfg, "focus", {}, { f: fake(JSON.stringify({ summary: "Do this first.", steps: [{ ref: key, why: "Waiting." }] })) });
    expect(json.text).toBe("Do this first.");
    expect(json.steps).toHaveLength(1);
    const plain = await runTool(db, a, cfg, "focus", {}, { f: fake("Just do the review.") });
    expect(plain.text).toBe("Just do the review.");
    expect(plain.steps).toBeUndefined();
  });
});

describe("whose work the snapshot lists", () => {
  it("lists blocked pull requests only when they involve the person, and counts the rest as not theirs", async () => {
    const { buildSnapshot, involvesMe } = await import("@/lib/services/ai-review");
    const { attention } = await import("@/lib/services/queries");
    const { db } = S;
    let sawWatched = false;
    for (const v of [S.admin, S.a, S.b]) {
      const att = await attention(db, v);
      const text = (await buildSnapshot(db, v)).text;
      const notMine = att.blocked.filter((d) => !involvesMe(d, v.login));
      for (const d of notMine) expect(text).not.toContain(`${d.item.repository.fullName}#${d.item.number} "`);
      if (notMine.length) {
        sawWatched = true;
        expect(text).toMatch(/Not yours: \d+ other pull request/);
      }
      for (const d of att.blocked.filter((x) => involvesMe(x, v.login)).slice(0, 5)) expect(text).toContain(`${d.item.repository.fullName}#${d.item.number} "`);
    }
    expect(sawWatched).toBe(true);
  });

  it("an item counts as the person's only when they wrote it, are assigned, or were asked to review", async () => {
    const { involvesMe } = await import("@/lib/services/ai-review");
    const base = { authorLogin: "carol", assigneeLogins: "|dave|", reviewRequests: [{ kind: "USER", reviewerRef: "Erin", removedAt: null }, { kind: "USER", reviewerRef: "frank", removedAt: new Date() }, { kind: "EXTERNAL_ROLE", reviewerRef: "gina", removedAt: null }] };
    const d = (over = {}) => ({ item: { ...base, ...over } }) as never;
    expect(involvesMe(d(), "Carol")).toBe(true); // author, case-insensitive
    expect(involvesMe(d(), "dave")).toBe(true); // assigned
    expect(involvesMe(d(), "erin")).toBe(true); // review requested
    expect(involvesMe(d(), "frank")).toBe(false); // the request was withdrawn
    expect(involvesMe(d(), "gina")).toBe(false); // a role, not a person
    expect(involvesMe(d(), "mallory")).toBe(false); // only watching
  });
});
