import { describe, expect, it } from "vitest";
import { chat, draftTasks, extractJson, listModels, normalizeBaseUrl, parseDrafts, resolveModel, stripThinking, type DraftContext } from "@/lib/services/ai";

const ctx: DraftContext = { projects: [{ id: "p1", name: "Atlas" }, { id: "p2", name: "Billing" }], people: ["Alice", "bob"], today: "2026-11-19", me: "joel" };
const cfg = { baseUrl: "https://ai.example.com/v1", apiKey: "k-secret", model: "qwen-x" };

const reply = (content: string) => ({ choices: [{ message: { content } }] });
const fakeFetch = (handler: (url: string, init: RequestInit) => unknown, status = 200) =>
  (async (url: string, init: RequestInit) => new Response(JSON.stringify(handler(String(url), init)), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("AI endpoint address", () => {
  it("accepts https, trims a trailing slash and rejects the rest", () => {
    expect(normalizeBaseUrl(" https://ai.kewaii.com/v1/ ")).toBe("https://ai.kewaii.com/v1");
    expect(normalizeBaseUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(() => normalizeBaseUrl("http://ai.example.com/v1")).toThrow(/https/);
    expect(() => normalizeBaseUrl("https://user:pw@ai.example.com/v1")).toThrow(/key/);
    expect(() => normalizeBaseUrl("not a url")).toThrow();
  });
});

describe("reading model output", () => {
  it("drops reasoning blocks and code fences", () => {
    expect(stripThinking("<think>hmm {\"a\":1}</think>\n{\"tasks\":[]}")).toBe('{"tasks":[]}');
    expect(extractJson('Sure!\n```json\n{"tasks":[{"title":"a}b"}]}\n```')).toEqual({ tasks: [{ title: "a}b" }] });
  });

  it("keeps only safe fields and resolves me, people, projects, dates and priorities", () => {
    const raw = JSON.stringify({
      tasks: [
        { title: "  Rotate   keys ", description: "d", project: "billing", assignee: "@ALICE", priority: "urgent", due: "2026-11-20", labels: ["ops", "ops", " sec "] },
        { title: "Fix redirect", assignee: "me", priority: 9, due: "tomorrow", project: "Nope", labels: "x" },
        { title: "Bad person", assignee: "not a login!" },
        { title: "" },
        { description: "no title" },
      ],
    });
    const d = parseDrafts(raw, ctx);
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ title: "Rotate keys", projectId: "p2", assignee: "Alice", priority: 4, due: "2026-11-20", labels: ["ops", "sec"] });
    expect(d[1]).toMatchObject({ assignee: "joel", priority: 0, due: null, projectId: "p1", labels: [] });
    expect(d[2].assignee).toBeNull();
  });

  it("refuses output with no usable task", () => {
    expect(() => parseDrafts("sorry, no", ctx)).toThrow(/did not return tasks/);
    expect(() => parseDrafts('{"tasks":[{"title":""}]}', ctx)).toThrow(/did not suggest/);
  });
});

describe("talking to the endpoint", () => {
  it("lists models with the key and de-duplicates them", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const f = fakeFetch((url, init) => {
      seen = { url, auth: new Headers(init.headers).get("authorization") };
      return { data: [{ id: "b-model" }, { id: "a-model" }, { id: "b-model" }, { nope: 1 }] };
    });
    expect(await listModels(cfg, f)).toEqual(["a-model", "b-model"]);
    expect(seen).toEqual({ url: "https://ai.example.com/v1/models", auth: "Bearer k-secret" });
  });

  it("uses the saved model while the endpoint still offers it", async () => {
    let sent: { model?: string; stream?: boolean; messages?: { role: string; content: string }[] } = {};
    const f = fakeFetch((url, init) => {
      if (url.endsWith("/models")) return { data: [{ id: "whatever-v9" }, { id: "other" }] };
      sent = JSON.parse(String(init.body));
      return reply('<think>plan</think>{"tasks":[{"title":"Ship it","assignee":"bob"}]}');
    });
    const r = await draftTasks({ ...cfg, model: "whatever-v9" }, "ship it, give to bob", ctx, f);
    expect(r.model).toBe("whatever-v9");
    expect(sent.model).toBe("whatever-v9");
    expect(sent.stream).toBe(false);
    expect(sent.messages?.[0].content).toContain("Atlas, Billing");
    expect(sent.messages?.[1]).toEqual({ role: "user", content: "ship it, give to bob" });
    expect(r.drafts[0]).toMatchObject({ title: "Ship it", assignee: "bob" });
  });

  it("adapts when the saved model is gone, or none is saved, and skips non-chat models", async () => {
    const f = fakeFetch(() => ({ data: [{ id: "text-embedding-3" }, { id: "new-chat-model" }] }));
    expect(await resolveModel({ ...cfg, model: "retired-model" }, f)).toBe("new-chat-model");
    expect(await resolveModel({ ...cfg, model: null }, f)).toBe("new-chat-model");
    expect(await resolveModel({ ...cfg, model: "text-embedding-3" }, f)).toBe("text-embedding-3");
  });

  it("falls back to the saved name when the list is unreadable, but not on a rejected key", async () => {
    expect(await resolveModel(cfg, fakeFetch(() => ({}), 500))).toBe("qwen-x");
    await expect(resolveModel(cfg, fakeFetch(() => ({}), 401))).rejects.toThrow(/rejected the key/);
    await expect(resolveModel({ ...cfg, model: null }, fakeFetch(() => ({ data: [] })))).rejects.toThrow(/does not offer/);
  });

  it("retries with another model when the chosen one is withdrawn mid-request", async () => {
    const used: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
      const model = JSON.parse(String(init.body)).model as string;
      used.push(model);
      return model === "a" ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(reply('{"tasks":[{"title":"Done"}]}')));
    }) as unknown as typeof fetch;
    const r = await draftTasks({ ...cfg, model: null }, "x", ctx, f);
    expect(used).toEqual(["a", "b"]);
    expect(r.model).toBe("b");
  });

  it("explains rejected keys, server errors and a missing model", async () => {
    await expect(listModels(cfg, fakeFetch(() => ({}), 401))).rejects.toThrow(/rejected the key/);
    await expect(chat(cfg, [{ role: "user", content: "x" }], fakeFetch(() => ({}), 500))).rejects.toThrow(/500/);
    await expect(chat({ ...cfg, model: null }, [{ role: "user", content: "x" }])).rejects.toThrow(/No model/);
    await expect(chat(cfg, [{ role: "user", content: "x" }], fakeFetch(() => reply("  ")))).rejects.toThrow(/no text/);
  });
});
