import type { Db } from "@/lib/db";
import { projectWhere, repoWhere, type Viewer } from "@/lib/authz/viewer";
import { parseQuickActions } from "@/lib/domain/quick-actions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { asStrings } from "@/lib/services/queries";
import { assigneeCandidates, cleanLabels, cleanLogin, createTask, listTasks, loadTask, priorityName, updateTask, type TaskPatch } from "@/lib/services/tasks";
import { flagBool, flagList, flagStr, hasControlChars, parseArgs, UsageError, type FlagSpec, type Parsed } from "./argv";
import { isBusy, withBusyRetry } from "./busy";
import { parseDue } from "./dates";
import { CliError } from "./locate";

/**
 * `npm run mp -- <command>`: Mergeport's own task records from the command line, for people and for AI agents.
 * It runs the same services as the web app, as the profile's own user, so every rule, limit and history entry is identical.
 * It never calls GitHub and never changes anything on GitHub: a task here is a planning record on this computer.
 * Pure: `scripts/mp.ts` supplies the database, the viewer and the output streams.
 */
export type MpOut = { stdout: (s: string) => void; stderr: (s: string) => void };
export type MpEnv = { db: Db; viewer: Viewer; now: () => Date; out: MpOut; sleep?: (ms: number) => Promise<void> };

export const DESCRIPTION_MAX = 8000;
const LIST_MAX = 500;

const USAGE = `Usage: npm run mp -- <command> [flags]   (add --json for machine-readable output)
  projects
  task add --title <t> (--repo <owner/name|name> | --project <name|id>) [--assign <login|me>] [--description <d>]
           [--priority none|low|medium|high|urgent] [--due <YYYY-MM-DD|today|tomorrow|fri|...>] [--label <l> ...]
           [--column <key|name>] [--any-login] [--dry-run]
  task update <id> [--title <t>] [--assign <login|me> | --unassign] [--priority <p>] [--due <date|none>]
           [--label <l> ...] [--unlabel <l> ...] [--column <key|name>] [--any-login]
  task done <id>
  task list [--mine | --assignee <login|me>] [--repo <r> | --project <p>] [--open] [--limit <n>]`;

const V: FlagSpec = { kind: "value" };
const L: FlagSpec = { kind: "list" };
const B: FlagSpec = { kind: "bool" };

type ProjectRow = Awaited<ReturnType<typeof visibleProjects>>[number];

async function visibleProjects(db: Db, v: Viewer) {
  return db.project.findMany({
    where: projectWhere(v),
    orderBy: { name: "asc" },
    include: {
      repositories: { where: { repository: repoWhere(v) }, include: { repository: { select: { id: true, fullName: true } } } },
      columns: { orderBy: { position: "asc" } },
    },
  });
}

const projectLabel = (p: { name: string; id: string }) => `${p.name} (${p.id})`;
const repoNames = (p: ProjectRow) => p.repositories.map((r) => r.repository.fullName).sort();

function resolveProject(projects: ProjectRow[], q: string): ProjectRow {
  const n = q.trim().toLowerCase();
  const hit = (list: ProjectRow[]) => {
    if (list.length === 1) return list[0];
    if (list.length > 1) throw new CliError(`"${q}" matches several projects. Pass the exact name or id.`, list.map(projectLabel));
    return null;
  };
  const found = hit(projects.filter((p) => p.id === q.trim())) ?? hit(projects.filter((p) => p.name.toLowerCase() === n)) ?? hit(n ? projects.filter((p) => p.name.toLowerCase().includes(n)) : []);
  if (!found) throw new CliError(`No project matching "${q}"`, projects.map(projectLabel));
  return found;
}

/** Tiers: whole name (owner/name), then the name after the slash, then a partial match. The first tier with a hit decides. */
function matchRepo(projects: ProjectRow[], q: string): { repo: { id: string; fullName: string }; projects: ProjectRow[] } {
  const n = q.trim().toLowerCase();
  const pairs = projects.flatMap((p) => p.repositories.map((r) => ({ p, repo: r.repository })));
  const tiers = [(f: string) => f === n, (f: string) => f.split("/")[1] === n, (f: string) => f.includes(n)];
  let hits: typeof pairs = [];
  if (n) for (const t of tiers) if ((hits = pairs.filter((x) => t(x.repo.fullName.toLowerCase()))).length) break;
  const repos = [...new Map(hits.map((h) => [h.repo.id, h.repo])).values()];
  if (repos.length === 0) throw new CliError(`No repository matching "${q}"`, [...new Set(pairs.map((x) => x.repo.fullName))].sort());
  if (repos.length > 1) throw new CliError(`"${q}" matches several repositories. Pass owner/name.`, repos.map((r) => r.fullName).sort());
  return { repo: repos[0], projects: hits.filter((h) => h.repo.id === repos[0].id).map((h) => h.p) };
}

function resolveTarget(projects: ProjectRow[], repoQ: string | undefined, projectQ: string | undefined): { project: ProjectRow; repo: string | null } {
  if (!repoQ && !projectQ) throw new UsageError("Give --repo <owner/name|name> or --project <name|id>");
  if (projectQ) {
    const project = resolveProject(projects, projectQ);
    if (!repoQ) return { project, repo: null };
    const m = matchRepo([project], repoQ);
    return { project, repo: m.repo.fullName };
  }
  const m = matchRepo(projects, repoQ!);
  if (m.projects.length > 1) throw new CliError(`${m.repo.fullName} is in several projects. Pass --project to pick one.`, m.projects.map(projectLabel));
  return { project: m.projects[0], repo: m.repo.fullName };
}

function resolveColumn(cols: { key: string; name: string }[], q: string) {
  const n = q.trim().toLowerCase();
  const c = cols.find((x) => x.key === n.replace(/\s+/g, "-") || x.name.toLowerCase() === n);
  if (!c) throw new CliError(`No column "${q}" in this project`, cols.map((x) => `${x.key} (${x.name})`));
  return c;
}

async function resolveAssignee(db: Db, v: Viewer, projectId: string, raw: string, anyLogin: boolean): Promise<string> {
  const who = raw.trim().replace(/^@/, "");
  if (who.toLowerCase() === "me") return v.login.toLowerCase();
  const login = cleanLogin(who);
  if (!login) throw new UsageError("--assign needs a GitHub login");
  const known = await assigneeCandidates(db, v, projectId);
  const exact = known.find((k) => k.toLowerCase() === login);
  if (exact) return exact.toLowerCase();
  const partial = known.filter((k) => k.toLowerCase().includes(login));
  if (partial.length === 1) return partial[0].toLowerCase();
  if (partial.length > 1) throw new CliError(`"${raw}" matches several people. Pass the exact login.`, partial.map((p) => `@${p}`));
  if (anyLogin) return login;
  throw new CliError(`@${login} is not a known person in this project. Pick one of these, or pass --any-login to assign a login Mergeport has not seen.`, known.map((k) => `@${k}`));
}

function parsePriority(raw: string): number {
  const k = raw.trim().toLowerCase();
  const op = /^[a-z0-9]{1,8}$/.test(k) ? parseQuickActions(`/priority ${k}`).ops[0] : undefined;
  if (!op || op.kind !== "priority") throw new UsageError(`Priority must be none, low, medium, high or urgent (got "${raw}")`);
  return op.value;
}

function text(raw: string, what: string, max: number, opts: { multiline?: boolean } = {}): string {
  const s = raw.trim();
  if (opts.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) : hasControlChars(s) || /[\r\n]/.test(s)) throw new UsageError(`${what} contains characters that are not allowed`);
  if (s.length > max) throw new ValidationError(`The ${what} can have at most ${max} characters`);
  return s;
}

type TaskRow = Awaited<ReturnType<typeof loadTask>>;
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const summary = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  project: { id: t.project.id, name: t.project.name },
  column: { key: t.column.key, name: t.column.name },
  done: t.column.key === "done",
  assignee: t.assigneeLogin,
  priority: priorityName(t.priority).toLowerCase(),
  due: day(t.dueDate),
  labels: asStrings(t.labels),
  link: `/tasks/${t.id}`,
});
const line = (s: { id?: string | null; title: string; project: string; repo?: string | null; column: string; assignee: string | null; priority: string; due: string | null; labels: string[] }) =>
  `"${s.title}" in ${s.project}${s.repo ? ` (${s.repo})` : ""}, ${s.column}` +
  `${s.assignee ? `, assigned to @${s.assignee}` : ""}${s.priority !== "no priority" ? `, priority ${s.priority}` : ""}${s.due ? `, due ${s.due}` : ""}${s.labels.length ? `, labels ${s.labels.join(", ")}` : ""}`;
const humanTask = (t: ReturnType<typeof summary>) => line({ title: t.title, project: t.project.name, column: t.column.name, assignee: t.assignee, priority: t.priority, due: t.due, labels: t.labels });

async function cliNote(env: MpEnv, itemId: string, body: string) {
  await withBusyRetry(() => env.db.taskComment.create({ data: { itemId, authorLogin: env.viewer.login, kind: "EVENT", body } }), { sleep: env.sleep });
}

export async function runMp(argv: string[], env: MpEnv): Promise<number> {
  const json = argv.includes("--json");
  const emit = (data: unknown, human: string) => env.out.stdout((json ? JSON.stringify(data) : human) + "\n");
  try {
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === "help" || cmd === "--help") {
      if (cmd === undefined) throw new UsageError("Missing command");
      env.out.stdout(USAGE + "\n");
      return 0;
    }
    if (cmd === "projects") {
      parseArgs(rest, { json: B }, 0);
      const projects = await withBusyRetry(() => visibleProjects(env.db, env.viewer), { sleep: env.sleep });
      const data = { viewer: { login: env.viewer.login }, projects: projects.map((p) => ({ id: p.id, name: p.name, shared: p.spaceId !== null, repos: repoNames(p), columns: p.columns.map((c) => ({ key: c.key, name: c.name })) })) };
      emit(data, data.projects.length ? data.projects.map((p) => `${p.name} (${p.id})\n  repos: ${p.repos.join(", ") || "none"}\n  columns: ${p.columns.map((c) => `${c.key}`).join(", ")}`).join("\n") : "No projects.");
      return 0;
    }
    if (cmd !== "task") throw new UsageError(`Unknown command "${cmd}"`);
    const [sub, ...args] = rest;
    if (sub === "add") return await taskAdd(env, args, emit);
    if (sub === "update") return await taskUpdate(env, args, emit);
    if (sub === "done") return await taskDone(env, args, emit);
    if (sub === "list") return await taskList(env, args, emit);
    throw new UsageError(`Unknown task command "${sub ?? ""}". Use add, update, done or list`);
  } catch (e) {
    return fail(e, json, env.out);
  }
}

function fail(e: unknown, json: boolean, out: MpOut): number {
  let code = 1;
  let message: string;
  let candidates: string[] | undefined;
  if (e instanceof UsageError) {
    code = 2;
    message = e.message;
  } else if (e instanceof CliError) {
    message = e.message;
    candidates = e.candidates;
  } else if (e instanceof NotFoundError) message = "Not found: there is no such task or project, or you cannot see it.";
  else if (e instanceof ValidationError || e instanceof ForbiddenError || e instanceof ConflictError) message = e.message;
  else if (isBusy(e)) message = "The Mergeport database stayed busy. Try again in a moment.";
  else message = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  if (json) out.stderr(JSON.stringify({ error: message, ...(candidates ? { candidates } : {}), ...(code === 2 ? { usage: true } : {}) }) + "\n");
  else out.stderr(`Error: ${message}\n${candidates?.length ? "Candidates:\n" + candidates.map((c) => `  ${c}`).join("\n") + "\n" : ""}${code === 2 ? "Run: npm run mp -- help\n" : ""}`);
  return code;
}

type Emit = (data: unknown, human: string) => void;

async function taskAdd(env: MpEnv, args: string[], emit: Emit): Promise<number> {
  const { db, viewer: v } = env;
  const p = parseArgs(args, { json: B, title: V, repo: V, project: V, assign: V, description: V, priority: V, due: V, label: L, column: V, "any-login": B, "dry-run": B }, 0);
  const rawTitle = flagStr(p, "title");
  if (rawTitle === undefined || !rawTitle.trim()) throw new UsageError("--title is required");
  const title = text(rawTitle, "title", 200);
  const description = flagStr(p, "description") === undefined ? undefined : text(flagStr(p, "description")!, "description", DESCRIPTION_MAX, { multiline: true });
  const priority = flagStr(p, "priority") === undefined ? undefined : parsePriority(flagStr(p, "priority")!);
  const due = flagStr(p, "due") === undefined ? undefined : parseDue(flagStr(p, "due")!, env.now(), v.timezone);
  if (due === null) throw new UsageError("--due none only makes sense when updating a task");
  const labels = cleanLabels(flagList(p, "label"));

  const projects = await withBusyRetry(() => visibleProjects(db, v), { sleep: env.sleep });
  const { project, repo } = resolveTarget(projects, flagStr(p, "repo"), flagStr(p, "project"));
  const column = resolveColumn(project.columns, flagStr(p, "column") ?? "backlog");
  const assignee = flagStr(p, "assign") === undefined ? null : await withBusyRetry(() => resolveAssignee(db, v, project.id, flagStr(p, "assign")!, flagBool(p, "any-login")), { sleep: env.sleep });

  const preview = { title, project: { id: project.id, name: project.name }, repo, column: { key: column.key, name: column.name }, assignee, priority: priorityName(priority ?? 0).toLowerCase(), due: due ?? null, labels, description: description ?? null };
  const human = line({ title, project: project.name, repo, column: column.name, assignee, priority: preview.priority, due: preview.due, labels });
  if (flagBool(p, "dry-run")) {
    emit({ ok: true, dryRun: true, wouldCreate: preview }, `Would create ${human}. Nothing was written.`);
    return 0;
  }

  const started = new Date(Date.now() - 60_000);
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let task;
  for (let attempt = 1; ; attempt++) {
    try {
      task = await createTask(db, v, { projectId: project.id, title, description, assigneeLogin: assignee, priority, dueDate: due ? new Date(due + "T00:00:00Z") : null, labels, columnKey: column.key });
      break;
    } catch (e) {
      if (!isBusy(e) || attempt >= 4) throw e;
      // A busy error can land after the card row was written. Retrying blindly would create a second task, so look first.
      const half = await withBusyRetry(() => db.planningItem.findFirst({ where: { projectId: project.id, title, createdById: v.memberId, createdAt: { gte: started } }, select: { id: true } }), { sleep: env.sleep });
      if (half) throw new CliError(`The database was busy while creating the task; task ${half.id} may be incomplete. Check /tasks/${half.id} before creating it again.`);
      await sleep(250 * attempt);
    }
  }
  await cliNote(env, task.id, "added this from the command line");
  emit({ ok: true, dryRun: false, task: { id: task.id, ...preview, link: `/tasks/${task.id}` } }, `Created task ${task.id}: ${human}. Open: /tasks/${task.id}`);
  return 0;
}

const needId = (p: Parsed, what: string) => {
  const id = p.positionals[0];
  if (!id) throw new UsageError(`${what} needs a task id`);
  return id;
};

async function changeTask(env: MpEnv, id: string, patch: TaskPatch, before: TaskRow): Promise<{ changed: boolean; task: ReturnType<typeof summary> }> {
  const after = await withBusyRetry(() => updateTask(env.db, env.viewer, id, patch), { sleep: env.sleep });
  const changed = after.version !== before.version;
  if (changed) await cliNote(env, id, "changed this from the command line");
  const fresh = await withBusyRetry(() => loadTask(env.db, env.viewer, id), { sleep: env.sleep });
  return { changed, task: summary(fresh) };
}

async function taskUpdate(env: MpEnv, args: string[], emit: Emit): Promise<number> {
  const { db, viewer: v } = env;
  const p = parseArgs(args, { json: B, title: V, assign: V, unassign: B, priority: V, due: V, label: L, unlabel: L, column: V, "any-login": B }, 1);
  const id = needId(p, "task update");
  if (flagStr(p, "assign") !== undefined && flagBool(p, "unassign")) throw new UsageError("Use --assign or --unassign, not both");
  const touches = ["title", "assign", "unassign", "priority", "due", "label", "unlabel", "column"].filter((k) => p.flags.has(k));
  if (!touches.length) throw new UsageError("Nothing to change. Give at least one of --title --assign --unassign --priority --due --label --unlabel --column");
  const t = await withBusyRetry(() => loadTask(db, v, id), { sleep: env.sleep });
  if (t.workItemId && ["title", "assign", "unassign", "label", "unlabel"].some((k) => p.flags.has(k))) throw new CliError("This card follows a GitHub item, so its title, labels and assignee belong to that item. Change priority, due date or column instead.");
  const patch: TaskPatch = {};
  if (p.flags.has("title")) patch.title = text(flagStr(p, "title")!, "title", 200);
  if (flagBool(p, "unassign")) patch.assigneeLogin = null;
  if (flagStr(p, "assign") !== undefined) patch.assigneeLogin = await withBusyRetry(() => resolveAssignee(db, v, t.projectId, flagStr(p, "assign")!, flagBool(p, "any-login")), { sleep: env.sleep });
  if (flagStr(p, "priority") !== undefined) patch.priority = parsePriority(flagStr(p, "priority")!);
  if (flagStr(p, "due") !== undefined) {
    const d = parseDue(flagStr(p, "due")!, env.now(), v.timezone);
    patch.dueDate = d ? new Date(d + "T00:00:00Z") : null;
  }
  if (p.flags.has("label") || p.flags.has("unlabel")) {
    const drop = new Set(cleanLabels(flagList(p, "unlabel")).map((l) => l.toLowerCase()));
    patch.labels = cleanLabels([...asStrings(t.labels).filter((l) => !drop.has(l.toLowerCase())), ...cleanLabels(flagList(p, "label"))]);
  }
  if (flagStr(p, "column") !== undefined) {
    const cols = await withBusyRetry(() => db.planningColumn.findMany({ where: { projectId: t.projectId }, orderBy: { position: "asc" } }), { sleep: env.sleep });
    patch.columnKey = resolveColumn(cols, flagStr(p, "column")!).key;
  }
  const r = await changeTask(env, id, patch, t);
  emit({ ok: true, changed: r.changed, task: r.task }, `${r.changed ? "Updated" : "No change to"} task ${id}: ${humanTask(r.task)}. Open: ${r.task.link}`);
  return 0;
}

async function taskDone(env: MpEnv, args: string[], emit: Emit): Promise<number> {
  const p = parseArgs(args, { json: B }, 1);
  const id = needId(p, "task done");
  const t = await withBusyRetry(() => loadTask(env.db, env.viewer, id), { sleep: env.sleep });
  const r = await changeTask(env, id, { columnKey: "done" }, t);
  emit({ ok: true, changed: r.changed, task: r.task }, `${r.changed ? "Marked done" : "Already done"}: task ${id} ${humanTask(r.task)}. Open: ${r.task.link}`);
  return 0;
}

async function taskList(env: MpEnv, args: string[], emit: Emit): Promise<number> {
  const { db, viewer: v } = env;
  const p = parseArgs(args, { json: B, mine: B, assignee: V, repo: V, project: V, open: B, limit: V }, 0);
  if (flagBool(p, "mine") && flagStr(p, "assignee") !== undefined) throw new UsageError("Use --mine or --assignee, not both");
  const limitRaw = flagStr(p, "limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new UsageError("--limit must be a whole number");
  const limit = Math.min(LIST_MAX, Math.max(1, Number(limitRaw ?? 50)));
  let projectIds: Set<string> | null = null;
  if (flagStr(p, "repo") !== undefined || flagStr(p, "project") !== undefined) {
    const projects = await withBusyRetry(() => visibleProjects(db, v), { sleep: env.sleep });
    if (flagStr(p, "project") !== undefined) projectIds = new Set([resolveProject(projects, flagStr(p, "project")!).id]);
    if (flagStr(p, "repo") !== undefined) {
      const m = matchRepo(projectIds ? projects.filter((x) => projectIds!.has(x.id)) : projects, flagStr(p, "repo")!);
      projectIds = new Set(m.projects.map((x) => x.id));
    }
  }
  let assignee: string | undefined;
  if (flagStr(p, "assignee") !== undefined) assignee = flagStr(p, "assignee")!.trim().toLowerCase() === "me" ? v.login.toLowerCase() : (cleanLogin(flagStr(p, "assignee")) ?? undefined);
  const rows = await withBusyRetry(() => listTasks(db, v, { scope: flagBool(p, "mine") ? "mine" : "all", assignee, status: flagBool(p, "open") ? "open" : "all" }), { sleep: env.sleep });
  const tasks = rows
    .filter((r) => !projectIds || projectIds.has(r.projectId))
    .slice(0, limit)
    .map((r) => ({ id: r.id, title: r.title, project: { id: r.project.id, name: r.project.name }, column: { key: r.column.key, name: r.column.name }, done: r.column.key === "done", assignee: r.assigneeLogin, priority: priorityName(r.priority).toLowerCase(), due: day(r.dueDate), labels: asStrings(r.labels), link: `/tasks/${r.id}` }));
  emit({ ok: true, count: tasks.length, tasks }, tasks.length ? tasks.map((t) => `${t.id}  ${humanTask(t)}`).join("\n") : "No tasks.");
  return 0;
}
