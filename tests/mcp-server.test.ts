import { beforeEach, describe, expect, it } from "vitest";
import { handle, SERVER_INFO } from "@/lib/mcp/server";
import { TOOLS } from "@/lib/mcp/tools";
import { listWorkItems } from "@/lib/services/queries";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { db: S.db, viewer: S.admin });
  const res = r!.result as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: !!res.isError };
};

describe("protocol", () => {
  it("negotiates the version, lists the tools, answers ping and ignores notifications", async () => {
    const ctx = { db: S.db, viewer: S.admin };
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, ctx);
    expect(init!.result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: SERVER_INFO, capabilities: { tools: {} } });
    expect(((await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999" } }, ctx))!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    const list = (await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx))!.result as { tools: { name: string; inputSchema: { type: string } }[] };
    expect(list.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(list.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect((await handle({ jsonrpc: "2.0", id: 4, method: "ping" }, ctx))!.result).toEqual({});
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
    expect((await handle({ jsonrpc: "2.0", id: 5, method: "nope" }, ctx))!.error?.code).toBe(-32601);
    expect((await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, ctx))!.error?.code).toBe(-32602);
  });
});

describe("tools", () => {
  it("creates, updates, lists and completes a task through the same code as the mp command", async () => {
    const projects = JSON.parse((await call("mergeport_projects", {})).text).projects as { id: string; name: string; repos: string[] }[];
    expect(projects.length).toBeGreaterThan(0);
    const p = projects[0];

    const dry = JSON.parse((await call("mergeport_create_task", { title: "Review paymentgateway#22", project: p.id, priority: "urgent", labels: ["review", "payments"], dry_run: true })).text);
    expect(dry).toMatchObject({ dryRun: true, wouldCreate: { title: "Review paymentgateway#22", priority: "urgent", labels: ["review", "payments"] } });

    const made = JSON.parse((await call("mergeport_create_task", { title: "Review paymentgateway#22", project: p.id, assign: "me", description: "--not a flag", priority: "high", due: "2026-12-01", labels: ["review"] })).text);
    expect(made.ok).toBe(true);
    const id = made.task.id as string;
    expect(made.task).toMatchObject({ assignee: S.admin.login.toLowerCase(), priority: "high", due: "2026-12-01" });

    expect(JSON.parse((await call("mergeport_update_task", { id, priority: "low", add_labels: ["urgent-ish"], remove_labels: ["review"], due: "none" })).text).task).toMatchObject({ priority: "low", due: null, labels: ["urgent-ish"] });
    expect(JSON.parse((await call("mergeport_list_tasks", { mine: true, open: true })).text).tasks.some((t: { id: string }) => t.id === id)).toBe(true);
    expect(JSON.parse((await call("mergeport_complete_task", { id })).text).task.done).toBe(true);
    expect(JSON.parse((await call("mergeport_list_tasks", { mine: true, open: true })).text).tasks.some((t: { id: string }) => t.id === id)).toBe(false);
  });

  it("passes on candidates when a name is ambiguous or unknown, as an error, never a guess", async () => {
    const r = await call("mergeport_create_task", { title: "x", project: "no-such-project-anywhere" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).candidates.length).toBeGreaterThan(0);
    expect((await call("mergeport_create_task", { title: "no target" })).isError).toBe(true);
    expect((await call("mergeport_update_task", {})).isError).toBe(true);
  });

  it("looks up a pull request and reports its review status from stored data only", async () => {
    const first = (await listWorkItems(S.db, S.admin, { type: "PULL_REQUEST", state: "OPEN", pageSize: 1 })).rows[0];
    const r = await call("mergeport_lookup_item", { query: `PR ${first.number} from ${first.repository.name}` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(first.title);
    expect(r.text).toMatch(/Review status:/);
    expect((await call("mergeport_lookup_item", { query: "PR 999999" })).text).toMatch(/No stored pull request/);
  });

  it("acts only as the profile's user: a member cannot reach another team's project", async () => {
    const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mergeport_projects", arguments: {} } }, { db: S.db, viewer: S.b });
    const mine = JSON.parse((r!.result as { content: { text: string }[] }).content[0].text).projects as { id: string }[];
    const all = JSON.parse((await call("mergeport_projects", {})).text).projects as { id: string }[];
    expect(mine.length).toBeLessThanOrEqual(all.length);
    const blocked = all.find((p) => !mine.some((m) => m.id === p.id));
    if (blocked) {
      const denied = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mergeport_create_task", arguments: { title: "sneak", project: blocked.id } } }, { db: S.db, viewer: S.b });
      expect((denied!.result as { isError?: boolean }).isError).toBe(true);
    }
  });
});
