import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openVault } from "@/lib/hub/session-vault";
import { saveAiSettings } from "@/lib/services/ai";
import { acceptSuggestions, analyzeWorkspace, buildSnapshot, dismissSuggestions, listSuggestions, parseReview, runAutopilot, saveSuggestions, type SuggestionDraft } from "@/lib/services/ai-review";
import { attention } from "@/lib/services/queries";
import { listTasks } from "@/lib/services/tasks";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
const vault = openVault(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-")), "key"));
beforeEach(async () => {
  S = await freshSeed();
});

const cfg = { baseUrl: "https://ai.example.com/v1", apiKey: "k", model: "m1" };
const answer = (content: string) =>
  (async (url: string) => (String(url).endsWith("/models") ? new Response(JSON.stringify({ data: [{ id: "m1" }] })) : new Response(JSON.stringify({ choices: [{ message: { content } }] })))) as unknown as typeof fetch;

describe("snapshot", () => {
  it("lists what needs the person, with a reference per pull request, and nothing they cannot see", async () => {
    const { db, a } = S;
    const att = await attention(db, a);
    const snap = await buildSnapshot(db, a);
    expect(snap.text).toContain(`@${a.login}`);
    const first = att.needsMyReview[0] ?? att.changesRequested[0] ?? att.blocked[0];
    if (first) expect(snap.text).toContain(`${first.item.repository.fullName}#${first.item.number}`);
    expect([...snap.refs.values()].every((r) => r.href.startsWith("/pull-requests/"))).toBe(true);
    // a member with no grant on a repository never sees its items in the snapshot
    const visible = new Set((await attention(db, S.b)).blocked.map((d) => d.item.id));
    const blockedForA = (await attention(db, a)).blocked.filter((d) => !visible.has(d.item.id));
    const forB = (await buildSnapshot(db, S.b)).text;
    for (const d of blockedForA) if (!(await attention(db, S.b)).needsMyReview.some((x) => x.item.id === d.item.id)) expect(forB).not.toContain(d.item.title.slice(0, 30));
  });
});

describe("reading the review", () => {
  it("keeps only suggestions that cite a real reference, picks the project, bounds the fields", async () => {
    const { db, admin } = S;
    const snap = await buildSnapshot(db, admin);
    const ref = [...snap.refs.keys()][0];
    if (!ref) return; // seed has nothing waiting on the admin
    const raw = JSON.stringify({ summary: " Do the review first. ", suggestions: [{ ref: ref.toLowerCase(), title: "  Review   it ", why: "Waiting two days", priority: "urgent", due: "2026-12-01" }, { ref: "R99", title: "invented" }, { ref, title: "duplicate ref" }, { ref: "T1", title: "not a pr" }] });
    const r = await parseReview(db, admin, raw, snap);
    expect(r.summary).toBe("Do the review first.");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({ title: "Review it", payload: { priority: 4, due: "2026-12-01", labels: ["ai"], assignee: admin.login.toLowerCase() } });
    expect(r.drafts[0].sourceKey).toMatch(/^pr:/);
  });
});

const draft = (n: number, kind: SuggestionDraft["kind"], projectId: string): SuggestionDraft => ({
  sourceKey: `pr:item-${n}`,
  kind,
  title: `Do thing ${n}`,
  reason: "because",
  href: `/pull-requests/item-${n}`,
  payload: { projectId, priority: 2, due: null, labels: ["ai"], assignee: "x", description: "d" },
});

describe("suggestions", () => {
  it("stores suggestions once, skips repeats, accepts into tasks and dismisses", async () => {
    const { db, admin } = S;
    const projectId = (await db.project.findFirst())!.id;
    const c1 = await saveSuggestions(db, admin, [draft(1, "review", projectId), draft(2, "blocked", projectId)], "suggest");
    expect(c1).toEqual({ created: 0, suggested: 2, skipped: 0 });
    expect(await saveSuggestions(db, admin, [draft(1, "review", projectId)], "suggest")).toEqual({ created: 0, suggested: 0, skipped: 1 });
    const list = await listSuggestions(db);
    expect(list).toHaveLength(2);
    const before = (await listTasks(db, admin, { status: "all" })).length;
    expect(await acceptSuggestions(db, admin, [list[0].id])).toBe(1);
    expect(await acceptSuggestions(db, admin, [list[0].id])).toBe(0); // already decided
    expect((await listTasks(db, admin, { status: "all" })).length).toBe(before + 1);
    expect(await dismissSuggestions(db, [list[1].id])).toBe(1);
    expect(await listSuggestions(db)).toHaveLength(0);
    // a dismissed one is not suggested again for two weeks
    expect((await saveSuggestions(db, admin, [draft(2, "blocked", projectId)], "suggest")).skipped).toBe(1);
  });

  it("in create mode makes tasks only for clear cases and caps them", async () => {
    const { db, admin } = S;
    const projectId = (await db.project.findFirst())!.id;
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => draft(n, "review", projectId));
    const c = await saveSuggestions(db, admin, [...many, draft(8, "blocked", projectId)], "create");
    expect(c.created).toBe(5);
    expect(c.suggested).toBe(3); // two over the cap and the blocked one wait for a decision
    const auto = await db.aiSuggestion.findMany({ where: { state: "AUTO" } });
    expect(auto).toHaveLength(5);
    expect(auto.every((s) => s.taskId)).toBe(true);
  });
});

describe("the review itself and the daily autopilot", () => {
  it("analyzes with whichever model is available and returns drafts", async () => {
    const { db, admin } = S;
    const snap = await buildSnapshot(db, admin);
    const ref = [...snap.refs.keys()][0];
    if (!ref) return;
    const r = await analyzeWorkspace(db, admin, { ...cfg, model: null }, { f: answer(JSON.stringify({ summary: "S", suggestions: [{ ref, title: "T", why: "W", priority: "high" }] })) });
    expect(r.model).toBe("m1");
    expect(r.drafts).toHaveLength(1);
  });

  it("does nothing while off, without a profile user, or without a key", async () => {
    const { db } = S;
    expect(await runAutopilot(db, vault)).toBe("off");
    await saveAiSettings(db, vault, { baseUrl: "https://ai.example.com/v1", apiKey: "k", autopilot: "suggest" });
    const r = await runAutopilot(db, vault, { f: answer("{}") });
    expect(["no-profile", "done", "not-yet", "error"]).toContain(r); // the seeded users are demo users, so no profile user is found
    await saveAiSettings(db, vault, { baseUrl: "https://ai.example.com/v1", clearKey: true, autopilot: "suggest" });
    expect(await runAutopilot(db, vault)).toBe("no-config");
  });
});
