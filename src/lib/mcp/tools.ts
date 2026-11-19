import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { runMp } from "@/lib/cli/mp";
import { gatherFacts } from "@/lib/services/ai-facts";
import { propose, status } from "@/lib/services/ai-approvals";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * What an AI app may do through Mergeport's MCP server. Everything goes through the same code as the `mp` command and the web app
 * (same limits, same history entries), as the signed-in profile's own user. Nothing here reads or changes anything on GitHub:
 * tasks are planning records on this computer, and the lookup only reads what Mergeport already stored.
 *
 * The propose_* tools are the one way to ask for a change on GitHub, and they only ASK: the request waits in Mergeport, with its exact
 * text, until the person approves it there. An AI app cannot approve its own request.
 */
export type ToolCtx = { db: Db; viewer: Viewer; now?: () => Date };
export type ToolResult = { text: string; isError?: boolean };

type Prop = { type: "string" | "boolean" | "integer" | "array"; description: string; items?: { type: "string" }; enum?: string[] };
export type Tool = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, Prop>; required?: string[]; additionalProperties: false }; run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult> };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const bool = (v: unknown) => v === true;

/** `--flag=value` keeps a value that starts with dashes a value, never a flag. */
function flags(map: Record<string, unknown>, spec: { values?: string[]; lists?: string[]; bools?: string[] }): string[] {
  const out: string[] = [];
  for (const k of spec.values ?? []) {
    const v = str(map[k.replace(/-/g, "_")]);
    if (v !== undefined) out.push(`--${k}=${v}`);
  }
  for (const k of spec.lists ?? []) {
    const list = map[k.replace(/-/g, "_")];
    if (Array.isArray(list)) for (const x of list) if (typeof x === "string" && x.trim()) out.push(`--${k}=${x}`);
  }
  for (const k of spec.bools ?? []) if (bool(map[k.replace(/-/g, "_")])) out.push(`--${k}`);
  return out;
}

async function mp(argv: string[], ctx: ToolCtx): Promise<ToolResult> {
  let out = "";
  let err = "";
  const code = await runMp([...argv, "--json"], { db: ctx.db, viewer: ctx.viewer, now: ctx.now ?? (() => new Date()), out: { stdout: (s) => (out += s), stderr: (s) => (err += s) } });
  if (code === 0) return { text: out.trim() };
  // The error is JSON with a message and, when a name was ambiguous, the candidates to choose from: pass it on so the AI can ask the person.
  return { text: (err || out).trim() || "That did not work.", isError: true };
}

const TARGET = {
  repo: { type: "string", description: "Repository the task is about: owner/name, or just the name. Use this or project." },
  project: { type: "string", description: "Project name or id. Use this or repo." },
} as const;

export const TOOLS: Tool[] = [
  // (the propose_* tools are appended below)
  {
    name: "mergeport_projects",
    description: "List the Mergeport projects you can see, with their repositories and board columns. Call this first when you are unsure which project or repository a task belongs to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (_a, ctx) => mp(["projects"], ctx),
  },
  {
    name: "mergeport_create_task",
    description:
      "Create a task (a planning card) in Mergeport. It is a record on this computer; nothing is created on GitHub. Give a repo or a project. If a name is ambiguous the result lists candidates: ask the person which one, do not guess. Set dry_run to preview without creating.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, up to 200 characters." },
        ...TARGET,
        assign: { type: "string", description: "GitHub login to assign, or \"me\"." },
        description: { type: "string", description: "Details, up to 8000 characters." },
        priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"], description: "Priority." },
        due: { type: "string", description: "Due date: YYYY-MM-DD, today, tomorrow, or a weekday such as fri." },
        labels: { type: "array", items: { type: "string" }, description: "Labels, up to 12." },
        column: { type: "string", description: "Board column key or name. Defaults to backlog." },
        dry_run: { type: "boolean", description: "Preview only; create nothing." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    run: (a, ctx) => mp(["task", "add", ...flags({ ...a, label: a.labels }, { values: ["title", "repo", "project", "assign", "description", "priority", "due", "column"], lists: ["label"], bools: ["dry-run"] })], ctx),
  },
  {
    name: "mergeport_update_task",
    description: "Change an existing task: title, assignee, priority, due date (\"none\" clears it), labels, or board column. Get the task id from mergeport_list_tasks or from the result of creating it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id." },
        title: { type: "string", description: "New title." },
        assign: { type: "string", description: "GitHub login to assign, or \"me\"." },
        unassign: { type: "boolean", description: "Remove the assignee." },
        priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"], description: "New priority." },
        due: { type: "string", description: "New due date, or \"none\"." },
        add_labels: { type: "array", items: { type: "string" }, description: "Labels to add." },
        remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove." },
        column: { type: "string", description: "Board column key or name." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (a, ctx) => {
      const id = str(a.id);
      if (!id) return Promise.resolve({ text: JSON.stringify({ error: "id is required" }), isError: true });
      return mp(["task", "update", id, ...flags(a, { values: ["title", "assign", "priority", "due", "column"], bools: ["unassign"] }), ...flags({ label: a.add_labels, unlabel: a.remove_labels }, { lists: ["label", "unlabel"] })], ctx);
    },
  },
  {
    name: "mergeport_complete_task",
    description: "Mark a task done (moves it to the Done column).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Task id." } }, required: ["id"], additionalProperties: false },
    run: (a, ctx) => {
      const id = str(a.id);
      return id ? mp(["task", "done", id], ctx) : Promise.resolve({ text: JSON.stringify({ error: "id is required" }), isError: true });
    },
  },
  {
    name: "mergeport_list_tasks",
    description: "List tasks. Filter to the person's own tasks, an assignee, a repository or project, and open tasks only.",
    inputSchema: {
      type: "object",
      properties: {
        mine: { type: "boolean", description: "Only tasks assigned to the signed-in person." },
        assignee: { type: "string", description: "GitHub login, or \"me\". Not together with mine." },
        ...TARGET,
        open: { type: "boolean", description: "Only tasks that are not done." },
        limit: { type: "integer", description: "At most this many (default 50, maximum 500)." },
      },
      additionalProperties: false,
    },
    run: (a, ctx) => mp(["task", "list", ...flags({ ...a, limit: typeof a.limit === "number" ? String(Math.trunc(a.limit)) : undefined }, { values: ["assignee", "repo", "project", "limit"], bools: ["mine", "open"] })], ctx),
  },
  {
    name: "mergeport_lookup_item",
    description:
      "Look up pull requests or issues Mergeport has stored and report their state, checks, conflicts and review status. Read-only, from local data (not live GitHub, so it can be a few minutes old). Include the number and, if you know it, the repository or author, for example \"PR 22 from KewaiiGamer/paymentgateway\".",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to find, such as \"PR 22 from paymentgateway\" or \"issue 7 by alice\"." } }, required: ["query"], additionalProperties: false },
    run: async (a, ctx) => {
      const q = str(a.query);
      if (!q) return { text: JSON.stringify({ error: "query is required" }), isError: true };
      const facts = await gatherFacts(ctx.db, ctx.viewer, q, ctx.now?.());
      if (facts.length === 0) return { text: "No stored pull request or issue matches that. Include its number, and the repository name if you know it." };
      return { text: facts.map((f) => `${f.text}${f.href ? `\nOpen in Mergeport: ${f.href}` : ""}`).join("\n\n") };
    },
  },
];

const QUEUED = (r: { id: string; summary: string }) =>
  JSON.stringify({ queued: true, id: r.id, summary: r.summary, note: "Nothing was sent to GitHub. The person must approve this in Mergeport (AI assistant, Approvals). Tell them it is waiting. Use mergeport_action_status to see what happened." });

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ValidationError || e instanceof ForbiddenError) return { text: JSON.stringify({ error: e.message }), isError: true };
    if (e instanceof NotFoundError) return { text: JSON.stringify({ error: "Not found, or you cannot see it." }), isError: true };
    throw e;
  }
}

const ITEM = { type: "string", description: "The pull request or issue: its Mergeport id, or text with the number and repository such as \"PR 22 from owner/repo\". Must match exactly one." } as const;

export const PROPOSE_TOOLS: Tool[] = [
  {
    name: "mergeport_propose_comment",
    description: "Ask to post a comment on a pull request or issue on GitHub, as the person. This only queues the request: the person approves the exact text in Mergeport before anything is sent.",
    inputSchema: { type: "object", properties: { item: ITEM, body: { type: "string", description: "The comment text, as it should be posted." } }, required: ["item", "body"], additionalProperties: false },
    run: (a, ctx) => guarded(async () => ({ text: QUEUED(await propose(ctx.db, ctx.viewer, { kind: "comment", item: String(a.item ?? ""), body: String(a.body ?? "") })) })),
  },
  {
    name: "mergeport_propose_review_request",
    description: "Ask to request a review on a pull request from GitHub users. This only queues the request: the person approves it in Mergeport before anything is sent.",
    inputSchema: { type: "object", properties: { item: ITEM, users: { type: "array", items: { type: "string" }, description: "GitHub usernames to ask, one to ten." } }, required: ["item", "users"], additionalProperties: false },
    run: (a, ctx) => guarded(async () => ({ text: QUEUED(await propose(ctx.db, ctx.viewer, { kind: "request-review", item: String(a.item ?? ""), users: Array.isArray(a.users) ? a.users.map(String) : [] })) })),
  },
  {
    name: "mergeport_propose_review",
    description: "Ask to submit a review on a pull request on GitHub as the person: COMMENT, REQUEST_CHANGES or APPROVE. This only queues the request: the person reads and approves it in Mergeport before anything is sent. Never describe an approval as done until the status says so.",
    inputSchema: { type: "object", properties: { item: ITEM, event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"], description: "The kind of review." }, body: { type: "string", description: "The review text. Required except for APPROVE." } }, required: ["item", "event"], additionalProperties: false },
    run: (a, ctx) => guarded(async () => ({ text: QUEUED(await propose(ctx.db, ctx.viewer, { kind: "review", item: String(a.item ?? ""), event: String(a.event ?? ""), body: a.body === undefined ? "" : String(a.body) })) })),
  },
  {
    name: "mergeport_action_status",
    description: "Where a queued request stands: PENDING (waiting for the person; if a send failed, the result says why and it is still waiting), DONE (sent), REJECTED or EXPIRED (nobody decided within a day).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The id returned when the request was queued." } }, required: ["id"], additionalProperties: false },
    run: (a, ctx) => guarded(async () => ({ text: JSON.stringify(await status(ctx.db, String(a.id ?? ""))) })),
  },
];

TOOLS.push(...PROPOSE_TOOLS);
