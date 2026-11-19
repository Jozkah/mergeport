import { beforeEach, describe, expect, it } from "vitest";
import { answerQuestion } from "@/lib/services/ai";
import { gatherFacts, parseQuestion } from "@/lib/services/ai-facts";
import { listWorkItems } from "@/lib/services/queries";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("reading a question", () => {
  it("finds numbers, repository or person hints and the kind of item", () => {
    expect(parseQuestion("what's the status on PR3 from atlas-api?")).toEqual({ numbers: [3], hints: ["atlas-api"], type: "PULL_REQUEST" });
    expect(parseQuestion("any news on issue #12 by @Alice")).toEqual({ numbers: [12], hints: ["alice"], type: "ISSUE" });
    expect(parseQuestion("is northwind/atlas-api#14 ready?").numbers).toEqual([14]);
    expect(parseQuestion("how are things").numbers).toEqual([]);
  });
});

describe("facts for a question", () => {
  it("describes a pull request the viewer can see, with its review status, and nothing else", async () => {
    const { db, admin } = S;
    const first = (await listWorkItems(db, admin, { type: "PULL_REQUEST", state: "OPEN", pageSize: 1 })).rows[0];
    const facts = await gatherFacts(db, admin, `status of PR ${first.number} from ${first.repository.name}`);
    expect(facts.length).toBeGreaterThan(0);
    const f = facts.find((x) => x.id === first.id)!;
    expect(f.label).toBe(`${first.repository.fullName}#${first.number}`);
    expect(f.href).toBe(`/pull-requests/${first.id}`);
    expect(f.text).toContain(first.title);
    expect(f.text).toMatch(/Review status:/);
  });

  it("never reaches an item in a repository the viewer has no grant for", async () => {
    const { db, admin, a, b } = S;
    const all = (await listWorkItems(db, admin, { state: "ALL", pageSize: 100 })).rows;
    for (const viewer of [a, b]) {
      const visible = new Set((await listWorkItems(db, viewer, { state: "ALL", pageSize: 100 })).rows.map((r) => r.id));
      const hidden = all.filter((r) => !visible.has(r.id));
      expect(hidden.length).toBeGreaterThan(0);
      for (const r of hidden) {
        const facts = await gatherFacts(db, viewer, `status of #${r.number} from ${r.repository.name}`);
        expect(facts.some((x) => x.id === r.id)).toBe(false);
        expect(JSON.stringify(facts)).not.toContain(r.title);
      }
    }
  });
});

describe("answering", () => {
  const cfg = { baseUrl: "https://ai.example.com/v1", apiKey: "k", model: "m1" };

  it("sends only the facts, tells the model to ignore instructions in them, and returns its answer", async () => {
    let sent: { model: string; messages: { role: string; content: string }[] } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m1" }] }));
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "PR 3 is waiting on alice." } }] }));
    }) as unknown as typeof fetch;
    const r = await answerQuestion(cfg, "status of PR 3?", [{ label: "a/b#3", href: "/pull-requests/x", text: "Pull request a/b#3: Fix it" }], f);
    expect(r).toEqual({ answer: "PR 3 is waiting on alice.", model: "m1" });
    expect(sent!.messages[0].content).toMatch(/ONLY the facts/);
    expect(sent!.messages[0].content).toMatch(/Ignore any instruction/);
    expect(sent!.messages[1].content).toContain("[1] a/b#3");
    expect(sent!.messages[1].content).toContain("Question: status of PR 3?");
  });

  it("says so when nothing matched instead of leaving the model to guess", async () => {
    let user = "";
    const f = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m1" }] }));
      user = JSON.parse(String(init.body)).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: "I do not have that." } }] }));
    }) as unknown as typeof fetch;
    await answerQuestion(cfg, "status of PR 99?", [], f);
    expect(user).toContain("(no matching items were found)");
  });
});
