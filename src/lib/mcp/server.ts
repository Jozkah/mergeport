import { TOOLS, type ToolCtx } from "./tools";

/**
 * A small Model Context Protocol server over stdio: one JSON message per line in, one per line out. Any MCP-capable app can use
 * it (Claude Code and Desktop, opencode, Cursor and others). It offers tools only. Pure: `handle` takes a message and returns the reply.
 */
export const SERVER_INFO = { name: "mergeport", version: "0.1.0" };
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const err = (id: Msg["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handle(msg: Msg, ctx: ToolCtx): Promise<Reply | null> {
  const { id, method, params } = msg;
  if (typeof method !== "string") return id === undefined ? null : err(id, -32600, "Invalid request");
  const notification = id === undefined;
  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      return notification ? null : { jsonrpc: "2.0", id: id!, result: { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: ctx.instructions ?? "Mergeport keeps tasks and pull request status on this computer. Use mergeport_projects when unsure where a task belongs; if a name is ambiguous, ask the person instead of guessing." } };
    }
    case "ping":
      return notification ? null : { jsonrpc: "2.0", id: id!, result: {} };
    case "tools/list":
      return notification ? null : { jsonrpc: "2.0", id: id!, result: { tools: (ctx.tools ?? TOOLS).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    case "tools/call": {
      if (notification) return null;
      const tool = (ctx.tools ?? TOOLS).find((t) => t.name === params?.name);
      if (!tool) return err(id, -32602, `Unknown tool ${String(params?.name)}`);
      const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const r = await tool.run(args, ctx);
        return { jsonrpc: "2.0", id: id!, result: { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) } };
      } catch (e) {
        return { jsonrpc: "2.0", id: id!, result: { content: [{ type: "text", text: ctx.quietErrors ? "Something went wrong. Nothing was changed." : `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }], isError: true } };
      }
    }
    default:
      // notifications such as notifications/initialized need no answer; an unknown request does
      return notification ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

/** Reads lines from `input`, answers on `write`. Resolves when input ends. */
export async function serve(input: AsyncIterable<string | Buffer>, write: (line: string) => void, ctx: ToolCtx): Promise<void> {
  let buf = "";
  const pending: Promise<void>[] = [];
  const one = async (line: string) => {
    let msg: Msg | Msg[];
    try {
      msg = JSON.parse(line);
    } catch {
      write(JSON.stringify(err(null, -32700, "Parse error")));
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const r = await handle(m, ctx);
      if (r) write(JSON.stringify(r));
    }
  };
  for await (const chunk of input) {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) pending.push(one(line));
    }
  }
  if (buf.trim()) pending.push(one(buf.trim()));
  await Promise.all(pending);
}
