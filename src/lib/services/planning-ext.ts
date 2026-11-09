import type { Db } from "@/lib/db";
import { requireProject, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { positionBetween } from "@/lib/domain/planning";
import { BOARD_TEMPLATES, DENSITIES, GROUPINGS, cleanBoardColumns, type BoardColumn, type GroupBy } from "@/lib/domain/boards";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "./audit";
import { recordColumnChange, recordPlanEvent } from "./plan-events";
import { planningWhere } from "./queries";

/** Boards, epics, iterations, release state and planning automation. Each action checks the project is one the viewer can see first. */

async function item(db: Db, v: Viewer, id: string) {
  const it = await db.planningItem.findFirst({ where: { id, ...(await planningWhere(db, v)) }, include: { column: true, workItem: true } });
  if (!it) throw new NotFoundError();
  if (it.workItem) await requireRepo(db, v, it.workItem.repositoryId, "manageWork");
  return it;
}
const projectKeys = async (db: Db, projectId: string) => (await db.planningColumn.findMany({ where: { projectId }, select: { key: true } })).map((c) => c.key);
const cleanName = (s: string, what: string) => {
  const n = s.trim();
  if (!n) throw new ValidationError(`Name the ${what}`);
  if (n.length > 80) throw new ValidationError(`A ${what} name can have at most 80 characters`);
  return n;
};

// ---------- boards ----------

export async function listBoards(db: Db, v: Viewer, projectId: string) {
  await requireProject(db, v, projectId);
  return db.planBoard.findMany({ where: { projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
}

export async function createBoard(db: Db, v: Viewer, input: { projectId: string; name?: string; template?: string; columns?: unknown; groupBy?: string; density?: string }) {
  await requireProject(db, v, input.projectId);
  const tpl = input.template ? BOARD_TEMPLATES.find((t) => t.key === input.template) : undefined;
  if (input.template && !tpl) throw new ValidationError("Unknown board template");
  const keys = await projectKeys(db, input.projectId);
  const columns = cleanBoardColumns(input.columns ?? tpl?.columns, keys);
  const name = cleanName(input.name ?? tpl?.name ?? "", "board");
  if ((await db.planBoard.count({ where: { projectId: input.projectId } })) >= 20) throw new ValidationError("A project can have at most 20 boards");
  if (await db.planBoard.findFirst({ where: { projectId: input.projectId, name } })) throw new ValidationError("A board with that name already exists");
  const groupBy = (GROUPINGS as readonly string[]).includes(input.groupBy ?? "none") ? (input.groupBy ?? "none") : "none";
  const density = (DENSITIES as readonly string[]).includes(input.density ?? "") ? input.density! : "comfortable";
  const b = await db.planBoard.create({ data: { projectId: input.projectId, name, template: tpl?.key ?? "", columns: columns as never, groupBy, density, position: await db.planBoard.count({ where: { projectId: input.projectId } }) } });
  await audit(db, v, "board.create", { type: "PlanBoard", id: b.id });
  return b;
}

export async function updateBoard(db: Db, v: Viewer, id: string, patch: { name?: string; columns?: unknown; groupBy?: GroupBy; density?: string }) {
  const b = await db.planBoard.findUnique({ where: { id } });
  if (!b) throw new NotFoundError();
  await requireProject(db, v, b.projectId);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    data.name = cleanName(patch.name, "board");
    if (await db.planBoard.findFirst({ where: { projectId: b.projectId, name: data.name as string, NOT: { id } } })) throw new ValidationError("A board with that name already exists");
  }
  if (patch.columns !== undefined) data.columns = cleanBoardColumns(patch.columns, await projectKeys(db, b.projectId)) as never;
  if (patch.groupBy !== undefined) {
    if (!(GROUPINGS as readonly string[]).includes(patch.groupBy)) throw new ValidationError("Unknown grouping");
    data.groupBy = patch.groupBy;
  }
  if (patch.density !== undefined) {
    if (!(DENSITIES as readonly string[]).includes(patch.density)) throw new ValidationError("Unknown density");
    data.density = patch.density;
  }
  return db.planBoard.update({ where: { id }, data });
}

export async function deleteBoard(db: Db, v: Viewer, id: string) {
  const b = await db.planBoard.findUnique({ where: { id } });
  if (!b) throw new NotFoundError();
  await requireProject(db, v, b.projectId);
  await db.planBoard.delete({ where: { id } }); // cards are untouched: a board only ever shows them
}

export const boardColumns = (b: { columns: unknown }) => b.columns as BoardColumn[];

// ---------- epics ----------

export async function createEpic(db: Db, v: Viewer, input: { projectId: string; title: string; description?: string; ownerLogin?: string | null; startDate?: Date | null; targetDate?: Date | null; decisions?: string }) {
  await requireProject(db, v, input.projectId);
  if (input.startDate && input.targetDate && input.targetDate < input.startDate) throw new ValidationError("The target date is before the start");
  const e = await db.epic.create({ data: { projectId: input.projectId, title: cleanName(input.title, "epic"), description: input.description?.trim() || null, ownerLogin: input.ownerLogin?.trim().replace(/^@/, "").toLowerCase() || null, startDate: input.startDate ?? null, targetDate: input.targetDate ?? null, decisions: input.decisions?.trim() || null } });
  await audit(db, v, "epic.create", { type: "Epic", id: e.id });
  return e;
}

export async function updateEpic(db: Db, v: Viewer, id: string, patch: { title?: string; description?: string | null; ownerLogin?: string | null; startDate?: Date | null; targetDate?: Date | null; status?: "OPEN" | "DONE"; decisions?: string | null }) {
  const e = await db.epic.findUnique({ where: { id } });
  if (!e) throw new NotFoundError();
  await requireProject(db, v, e.projectId);
  const start = patch.startDate !== undefined ? patch.startDate : e.startDate;
  const end = patch.targetDate !== undefined ? patch.targetDate : e.targetDate;
  if (start && end && end < start) throw new ValidationError("The target date is before the start");
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = cleanName(patch.title, "epic");
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.ownerLogin !== undefined) data.ownerLogin = patch.ownerLogin?.trim().replace(/^@/, "").toLowerCase() || null;
  if (patch.startDate !== undefined) data.startDate = patch.startDate;
  if (patch.targetDate !== undefined) data.targetDate = patch.targetDate;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.decisions !== undefined) data.decisions = patch.decisions?.trim() || null;
  return db.epic.update({ where: { id }, data });
}

export async function deleteEpic(db: Db, v: Viewer, id: string) {
  const e = await db.epic.findUnique({ where: { id } });
  if (!e) throw new NotFoundError();
  await requireProject(db, v, e.projectId);
  await db.planningItem.updateMany({ where: { epicId: id }, data: { epicId: null } }); // children stay; only the grouping goes
  await db.epic.delete({ where: { id } });
}

/** One level only: a card belongs to at most one epic of its own project, and an epic cannot belong to another. */
export async function assignEpic(db: Db, v: Viewer, itemId: string, epicId: string | null) {
  const it = await item(db, v, itemId);
  if (epicId) {
    const e = await db.epic.findFirst({ where: { id: epicId, projectId: it.projectId } });
    if (!e) throw new NotFoundError();
  }
  if ((it.epicId ?? null) === epicId) return;
  await db.planningItem.update({ where: { id: it.id }, data: { epicId, version: { increment: 1 } } });
  await recordPlanEvent(db, { projectId: it.projectId, itemId: it.id, kind: "epic", refId: epicId, actorLogin: v.login });
}

export type EpicRow = { id: string; title: string; description: string | null; ownerLogin: string | null; startDate: Date | null; targetDate: Date | null; status: string; decisions: string | null; done: number; total: number; hidden: number };

/** Epics with progress over the children the viewer can see; the number they cannot see is reported, not hidden. */
export async function listEpics(db: Db, v: Viewer, projectId: string): Promise<EpicRow[]> {
  await requireProject(db, v, projectId);
  const epics = await db.epic.findMany({ where: { projectId }, orderBy: [{ status: "asc" }, { targetDate: "asc" }, { createdAt: "asc" }] });
  const visible = await db.planningItem.findMany({ where: { AND: [await planningWhere(db, v, projectId), { epicId: { not: null } }] }, select: { epicId: true, column: { select: { key: true } } } });
  const all = await db.planningItem.groupBy({ by: ["epicId"], where: { projectId, epicId: { not: null } }, _count: { _all: true } });
  const totalBy = new Map(all.map((r) => [r.epicId!, r._count._all]));
  return epics.map((e) => {
    const mine = visible.filter((i) => i.epicId === e.id);
    return { id: e.id, title: e.title, description: e.description, ownerLogin: e.ownerLogin, startDate: e.startDate, targetDate: e.targetDate, status: e.status, decisions: e.decisions, done: mine.filter((i) => i.column.key === "done").length, total: mine.length, hidden: (totalBy.get(e.id) ?? 0) - mine.length };
  });
}

// ---------- iterations ----------

export async function createIteration(db: Db, v: Viewer, input: { projectId: string; name: string; startDate: Date; endDate: Date }) {
  await requireProject(db, v, input.projectId);
  if (input.endDate <= input.startDate) throw new ValidationError("An iteration must end after it starts");
  const clash = await db.iteration.findFirst({ where: { projectId: input.projectId, startDate: { lt: input.endDate }, endDate: { gt: input.startDate } } });
  if (clash) throw new ValidationError(`That overlaps ${clash.name}`);
  const it = await db.iteration.create({ data: { projectId: input.projectId, name: cleanName(input.name, "iteration"), startDate: input.startDate, endDate: input.endDate } });
  await audit(db, v, "iteration.create", { type: "Iteration", id: it.id });
  return it;
}

export async function assignIteration(db: Db, v: Viewer, itemId: string, iterationId: string | null) {
  const it = await item(db, v, itemId);
  if (iterationId && !(await db.iteration.findFirst({ where: { id: iterationId, projectId: it.projectId, closedAt: null } }))) throw new ValidationError("Choose an open iteration of this project");
  if ((it.iterationId ?? null) === iterationId) return;
  await db.planningItem.update({ where: { id: it.id }, data: { iterationId, version: { increment: 1 } } });
  await recordPlanEvent(db, { projectId: it.projectId, itemId: it.id, kind: "iteration", refId: iterationId, actorLogin: v.login });
}

/**
 * Closing an iteration decides, explicitly, what happens to its unfinished work: it moves to the chosen next iteration (and each
 * move is recorded as a carry-over), or it is left without an iteration. Finished work stays with the iteration that finished it.
 */
export async function closeIteration(db: Db, v: Viewer, iterationId: string, carryTo: string | null) {
  const it = await db.iteration.findUnique({ where: { id: iterationId } });
  if (!it) throw new NotFoundError();
  await requireProject(db, v, it.projectId);
  if (it.closedAt) throw new ValidationError("That iteration is already closed");
  if (carryTo) {
    const next = await db.iteration.findFirst({ where: { id: carryTo, projectId: it.projectId, closedAt: null, NOT: { id: iterationId } } });
    if (!next) throw new ValidationError("Choose another open iteration to carry the unfinished work to");
  }
  const unfinished = await db.planningItem.findMany({ where: { iterationId, column: { key: { not: "done" } } }, select: { id: true } });
  for (const u of unfinished) {
    await db.planningItem.update({ where: { id: u.id }, data: { iterationId: carryTo, version: { increment: 1 } } });
    await recordPlanEvent(db, { projectId: it.projectId, itemId: u.id, kind: "carried-over", refId: carryTo, fromKey: iterationId, actorLogin: v.login });
  }
  await db.iteration.update({ where: { id: iterationId }, data: { closedAt: new Date() } });
  await audit(db, v, "iteration.close", { type: "Iteration", id: iterationId }, { carried: unfinished.length });
  return { carried: unfinished.length };
}

// ---------- milestone release readiness ----------

export type ReleaseReadiness = {
  milestone: { id: string; name: string; targetDate: Date | null; releaseTag: string | null; releaseUrl: string | null; shippedAt: Date | null };
  total: number;
  hidden: number;
  /** Every visible card is done. Not the same as shipped. */
  workFinished: boolean;
  shipped: boolean;
  unfinished: { id: string; title: string; column: string }[];
  failingChecks: { id: string; title: string }[];
  blocked: { id: string; title: string; blockers: number }[];
  pendingDecisions: { id: string; title: string; waitingOn: string }[];
};

export async function releaseReadiness(db: Db, v: Viewer, milestoneId: string): Promise<ReleaseReadiness> {
  const ms = await db.dashboardMilestone.findFirst({ where: { id: milestoneId, workspaceId: v.workspaceId } });
  if (!ms) throw new NotFoundError();
  if (!v.isAdmin && ms.projectId) await requireProject(db, v, ms.projectId);
  const items = await db.planningItem.findMany({
    where: { AND: [{ milestoneId }, await planningWhere(db, v)] },
    include: { column: true, workItem: { select: { type: true, state: true, checksState: true, title: true } }, waiting: { where: { status: "PENDING" } }, blockedBy: { include: { from: { include: { column: true, workItem: { select: { type: true, state: true } } } } } } },
  });
  const { blockerFinished } = await import("@/lib/domain/deps");
  const total = await db.planningItem.count({ where: { milestoneId } });
  const title = (i: (typeof items)[number]) => i.workItem?.title ?? i.title;
  const unfinished = items.filter((i) => i.column.key !== "done");
  return {
    milestone: { id: ms.id, name: ms.name, targetDate: ms.targetDate, releaseTag: ms.releaseTag, releaseUrl: ms.releaseUrl, shippedAt: ms.shippedAt },
    total,
    hidden: total - items.length,
    workFinished: items.length > 0 && unfinished.length === 0 && total === items.length,
    shipped: !!ms.shippedAt,
    unfinished: unfinished.map((i) => ({ id: i.id, title: title(i), column: i.column.name ?? i.column.key })),
    failingChecks: items.filter((i) => i.column.key !== "done" && i.workItem?.type === "PULL_REQUEST" && i.workItem.checksState === "FAILURE").map((i) => ({ id: i.id, title: title(i) })),
    blocked: unfinished.map((i) => ({ i, n: i.blockedBy.filter((l) => l.kind === "blocks" && !blockerFinished({ columnKey: l.from.column.key, workType: l.from.workItem?.type ?? null, workState: l.from.workItem?.state ?? null })).length })).filter((x) => x.n > 0).map((x) => ({ id: x.i.id, title: title(x.i), blockers: x.n })),
    pendingDecisions: unfinished.filter((i) => i.waiting.length > 0).map((i) => ({ id: i.id, title: title(i), waitingOn: i.waiting[0].reviewerRef })),
  };
}

/** Records that the release went out. Separate from finishing the work; it can only be done by someone who can administer the project. */
export async function setShipped(db: Db, v: Viewer, milestoneId: string, shipped: boolean, info: { tag?: string; url?: string } = {}) {
  const ms = await db.dashboardMilestone.findFirst({ where: { id: milestoneId, workspaceId: v.workspaceId } });
  if (!ms) throw new NotFoundError();
  if (!v.isAdmin) throw new ValidationError("Only an administrator can mark a release as shipped");
  const url = info.url?.trim() || null;
  if (url && !/^https:\/\//i.test(url)) throw new ValidationError("The release link must start with https://");
  await db.dashboardMilestone.update({ where: { id: milestoneId }, data: shipped ? { shippedAt: new Date(), releaseTag: info.tag?.trim().slice(0, 80) || null, releaseUrl: url } : { shippedAt: null } });
  await audit(db, v, shipped ? "milestone.ship" : "milestone.unship", { type: "DashboardMilestone", id: milestoneId });
}

// ---------- planning automation (suggestions only) ----------

export async function setAutomation(db: Db, v: Viewer, projectId: string, mode: "off" | "suggest") {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change a project's automation");
  await requireProject(db, v, projectId);
  await db.project.update({ where: { id: projectId }, data: { automation: mode } });
  await audit(db, v, "project.automation", { type: "Project", id: projectId }, { mode });
}

export type Suggestion = { itemId: string; title: string; from: string; to: "done"; why: string };

/**
 * "A merged pull request or a closed issue suggests Done." Only when the project turned suggestions on. This is a preview: nothing
 * moves until a person applies a suggestion, and applying it changes the local board only. GitHub is never written to.
 */
export async function suggestedMoves(db: Db, v: Viewer, projectId: string): Promise<Suggestion[]> {
  const p = await requireProject(db, v, projectId);
  if (p.automation !== "suggest") return [];
  const items = await db.planningItem.findMany({ where: { AND: [await planningWhere(db, v, projectId), { workItemId: { not: null }, column: { key: { not: "done" } } }] }, include: { column: true, workItem: { select: { type: true, state: true, title: true, number: true } } } });
  const out: Suggestion[] = [];
  for (const i of items) {
    const w = i.workItem!;
    if (w.type === "PULL_REQUEST" && w.state === "MERGED") out.push({ itemId: i.id, title: w.title, from: i.column.name ?? i.column.key, to: "done", why: `Pull request #${w.number} was merged` });
    else if (w.type === "ISSUE" && w.state === "CLOSED") out.push({ itemId: i.id, title: w.title, from: i.column.name ?? i.column.key, to: "done", why: `Issue #${w.number} was closed` });
    // A pull request closed without merging is deliberately not suggested: nothing was delivered.
  }
  return out;
}

export async function applySuggestion(db: Db, v: Viewer, itemId: string) {
  const it = await item(db, v, itemId);
  const project = await db.project.findUniqueOrThrow({ where: { id: it.projectId } });
  const current = (await suggestedMoves(db, v, it.projectId)).find((s) => s.itemId === itemId);
  if (project.automation !== "suggest" || !current) throw new ValidationError("That suggestion no longer applies");
  const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: it.projectId, key: "done" } });
  const last = await db.planningItem.findFirst({ where: { columnId: done.id }, orderBy: { position: "desc" } });
  await db.planningItem.update({ where: { id: it.id }, data: { columnId: done.id, position: positionBetween(last?.position ?? null, null), version: { increment: 1 } } });
  await recordColumnChange(db, { projectId: it.projectId, itemId: it.id, from: it.column.key, to: "done", actorLogin: v.login });
  await audit(db, v, "planning.suggestion-applied", { type: "PlanningItem", id: it.id });
}
