import type { Db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { repoWhere, requireProject, requireRepo, requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { checkVersion, computeProgress, positionBetween, wouldCreateCycle, type PlanItem } from "@/lib/domain/planning";
import { STAGE_KEYS, type StageKey } from "@/lib/domain/stages";
import { audit } from "./audit";
import { planningWhere } from "./queries";

export const DEFAULT_COLUMNS = [
  { key: "backlog", name: "Backlog" },
  { key: "ready", name: "Ready" },
  { key: "in-progress", name: "In progress" },
  { key: "in-review", name: "In review" },
  { key: "blocked", name: "Blocked" },
  { key: "done", name: "Done" },
] as const;

/** A planning item must be visible to the viewer before any mutation touches it. */
async function requireItem(db: Db, v: Viewer, itemId: string) {
  const item = await db.planningItem.findFirst({ where: { id: itemId, ...(await planningWhere(db, v)) }, include: { column: true, workItem: true } });
  if (!item) throw new NotFoundError();
  return item;
}

async function requireManage(db: Db, v: Viewer, item: { workItem: { repositoryId: string } | null }) {
  if (item.workItem) await requireRepo(db, v, item.workItem.repositoryId, "manageWork");
}

export async function createColumnsForProject(db: Db, projectId: string) {
  for (const [i, c] of DEFAULT_COLUMNS.entries()) {
    await db.planningColumn.upsert({ where: { projectId_key: { projectId, key: c.key } }, create: { projectId, key: c.key, name: c.name, position: i }, update: {} });
  }
}

export async function createCard(
  db: Db,
  v: Viewer,
  input: { projectId: string; title?: string; workItemId?: string; columnKey?: string; priority?: number; dueDate?: Date | null; assigneeLogin?: string | null; milestoneId?: string | null },
) {
  const project = await requireProject(db, v, input.projectId);
  if (!input.workItemId && !input.title?.trim()) throw new ValidationError("Give the task a title");
  let title = input.title?.trim() ?? "";
  if (input.workItemId) {
    // Referenced entity validated: must be visible AND manageable, else NotFound/Forbidden. Prevents forging a hidden item id.
    const wi = await requireWorkItem(db, v, input.workItemId, "manageWork");
    const inProject = await db.projectRepository.findFirst({ where: { projectId: project.id, repositoryId: wi.repositoryId } });
    if (!inProject) throw new ValidationError("That repository is not part of this project");
    await assertSameAudience(db, project.spaceId, [wi.repositoryId]);
    title = wi.title;
  } else if (!v.isAdmin) {
    const m = await db.projectMember.findFirst({ where: { projectId: project.id, memberId: v.memberId } });
    if (!m) throw new NotFoundError();
  }
  if (input.milestoneId) {
    const ms = await db.dashboardMilestone.findFirst({ where: { id: input.milestoneId, workspaceId: v.workspaceId, OR: [{ projectId: project.id }, { projectId: null }] } });
    if (!ms) throw new NotFoundError();
  }
  const column = await db.planningColumn.findFirst({ where: { projectId: project.id, key: input.columnKey ?? "backlog" } });
  if (!column) throw new ValidationError("Unknown column");
  const last = await db.planningItem.findFirst({ where: { columnId: column.id }, orderBy: { position: "desc" } });
  const card = await db.planningItem.create({
    data: {
      projectId: project.id,
      columnId: column.id,
      position: positionBetween(last?.position ?? null, null),
      title,
      workItemId: input.workItemId ?? null,
      priority: input.priority ?? 0,
      dueDate: input.dueDate ?? null,
      assigneeLogin: input.assigneeLogin?.toLowerCase() ?? null,
      milestoneId: input.milestoneId ?? null,
      createdById: v.memberId,
    },
  });
  await audit(db, v, "planning.create", { type: "PlanningItem", id: card.id });
  return card;
}

/**
 * Move a card with optimistic concurrency. A stale `expectedVersion` returns ConflictError and
 * changes nothing. Dragging never touches GitHub state or labels.
 */
/**
 * A project that is shared through a space writes its repository links, card titles and issue numbers into that space's
 * repository, so every repository it links must belong to the SAME audience. Otherwise a narrower space's data would be
 * published to a wider one.
 */
export async function assertSameAudience(db: Db, projectSpaceId: string | null, repositoryIds: string[]) {
  if (!projectSpaceId || repositoryIds.length === 0) return;
  const mismatched = await db.repository.count({ where: { id: { in: repositoryIds }, OR: [{ spaceId: null }, { spaceId: { not: projectSpaceId } }] } });
  if (mismatched) throw new ValidationError("A project shared through a space can only link repositories shared through that same space. Share the repository to the space first, so nobody sees more than their space allows.");
}

export async function moveCard(db: Db, v: Viewer, input: { itemId: string; toColumnKey: string; beforePosition?: number | null; afterPosition?: number | null; expectedVersion: number }) {
  const item = await requireItem(db, v, input.itemId);
  await requireManage(db, v, item);
  const column = await db.planningColumn.findFirst({ where: { projectId: item.projectId, key: input.toColumnKey } });
  if (!column) throw new ValidationError("Unknown column");
  const chk = checkVersion(item.version, input.expectedVersion);
  if (!chk.ok) throw new ConflictError();
  const position = positionBetween(input.beforePosition ?? null, input.afterPosition ?? null);
  // Version is also checked in the WHERE clause so two racing writers cannot both win.
  const res = await db.planningItem.updateMany({
    where: { id: item.id, version: input.expectedVersion },
    data: { columnId: column.id, position, version: { increment: 1 } },
  });
  if (res.count !== 1) throw new ConflictError();
  await audit(db, v, "planning.move", { type: "PlanningItem", id: item.id }, { to: column.key });
  return { version: chk.version };
}

/** Dependency: `blockerId` blocks `blockedId`. Both ends must be visible; cycles are rejected. */
export async function addDependency(db: Db, v: Viewer, blockerId: string, blockedId: string) {
  const [a, b] = await Promise.all([requireItem(db, v, blockerId), requireItem(db, v, blockedId)]);
  await requireManage(db, v, b);
  if (a.projectId !== b.projectId) throw new ValidationError("Dependencies stay within one project");
  const edges = await db.planningLink.findMany({ where: { from: { projectId: a.projectId } } });
  if (wouldCreateCycle(edges.map((e) => ({ from: e.fromId, to: e.toId })), a.id, b.id)) throw new ValidationError("That dependency would create a cycle");
  await db.planningLink.upsert({ where: { fromId_toId: { fromId: a.id, toId: b.id } }, create: { fromId: a.id, toId: b.id }, update: {} });
  await audit(db, v, "planning.link", { type: "PlanningItem", id: b.id }, { blocker: a.id });
}

/** Dependencies as the viewer may see them. A hidden endpoint becomes an opaque marker with no title or id. */
export async function listDependencies(db: Db, v: Viewer, itemId: string) {
  await requireItem(db, v, itemId);
  const links = await db.planningLink.findMany({ where: { OR: [{ fromId: itemId }, { toId: itemId }] } });
  const otherIds = links.map((l) => (l.fromId === itemId ? l.toId : l.fromId));
  const visible = await db.planningItem.findMany({ where: { id: { in: otherIds }, ...(await planningWhere(db, v)) }, select: { id: true, title: true, column: { select: { key: true } } } });
  const vis = new Map(visible.map((i) => [i.id, i]));
  return links.map((l) => {
    const other = l.fromId === itemId ? l.toId : l.fromId;
    const o = vis.get(other);
    const direction = l.fromId === itemId ? ("blocks" as const) : ("blocked-by" as const);
    return o ? { direction, opaque: false as const, id: o.id, title: o.title, done: o.column.key === "done" } : { direction, opaque: true as const };
  });
}

/** Unfinished blockers, counting hidden ones (blocked status is true even when the blocker is not visible). */
export async function blockedByCount(db: Db, itemId: string) {
  return db.planningLink.count({ where: { toId: itemId, from: { column: { key: { not: "done" } } } } });
}

export async function milestoneProgress(db: Db, v: Viewer, milestoneId: string) {
  const ms = await db.dashboardMilestone.findFirst({ where: { id: milestoneId, workspaceId: v.workspaceId } });
  if (!ms) throw new NotFoundError();
  if (!v.isAdmin && ms.projectId) await requireProject(db, v, ms.projectId);
  const items = await db.planningItem.findMany({
    where: { AND: [{ milestoneId }, await planningWhere(db, v)] },
    include: { column: true },
  });
  const plan: PlanItem[] = items.map((i) => ({ id: i.id, workItemId: i.workItemId, columnKey: i.column.key }));
  return { milestone: { id: ms.id, name: ms.name, targetDate: ms.targetDate }, progress: computeProgress(plan) };
}

// ---------- manual waiting (non-PR items) ----------

export async function requestManualReview(db: Db, v: Viewer, input: { planningItemId?: string; workItemId?: string; reviewerKind: "USER" | "EXTERNAL_ROLE"; reviewerRef: string; reason: string; stage?: string }) {
  if (!input.planningItemId === !input.workItemId) throw new ValidationError("Choose exactly one item");
  if (!input.reason.trim()) throw new ValidationError("Say why this is waiting");
  if (input.planningItemId) {
    const item = await requireItem(db, v, input.planningItemId);
    await requireManage(db, v, item);
  } else {
    await requireWorkItem(db, v, input.workItemId!, "manageWork");
  }
  const rec = await db.waitingRecord.create({
    data: { workspaceId: v.workspaceId, planningItemId: input.planningItemId, workItemId: input.workItemId, source: "MANUAL", reviewerKind: input.reviewerKind, reviewerRef: input.reviewerRef, reason: input.reason.trim(), stage: STAGE_KEYS.includes(input.stage as StageKey) ? input.stage! : "" },
  });
  await audit(db, v, "waiting.request", { type: "WaitingRecord", id: rec.id });
  return rec;
}

/** Only the named reviewer or an administrator can clear a manual waiting record. A comment never does. */
export async function resolveManualReview(db: Db, v: Viewer, recordId: string, outcome: "SATISFIED" | "CANCELLED", note: string) {
  const rec = await db.waitingRecord.findFirst({ where: { id: recordId, workspaceId: v.workspaceId, status: "PENDING", source: "MANUAL" } });
  if (!rec) throw new NotFoundError();
  // Authorization context: the record's item must be visible to the viewer.
  if (rec.workItemId) await requireWorkItem(db, v, rec.workItemId);
  else if (rec.planningItemId) await requireItem(db, v, rec.planningItemId);
  const isNamed = rec.reviewerKind === "USER" && rec.reviewerRef.toLowerCase() === v.login.toLowerCase();
  if (!v.isAdmin && !isNamed) throw new ForbiddenError("Only the requested reviewer or an administrator can decide this");
  await db.waitingRecord.update({ where: { id: rec.id }, data: { status: outcome, clearedAt: new Date(), clearedById: v.userId, clearReason: note } });
  await audit(db, v, "waiting.resolve", { type: "WaitingRecord", id: rec.id }, { outcome });
}

export { repoWhere };
