import { checklistProgress } from "./tasks";
import type { Db } from "@/lib/db";
import { repoWhere, type Viewer } from "@/lib/authz/viewer";
import { isOverdue, todayIn } from "@/lib/domain/planning";
import { formatDateOnly } from "@/lib/format";
import { planningWhere, asLabels } from "./queries";

export type CardView = {
  id: string;
  checklist: { done: number; total: number };
  columnKey: string;
  position: number;
  version: number;
  title: string;
  isDraft: boolean;
  repoFullName: string | null;
  number: number | null;
  workState: string | null;
  href: string | null;
  labels: { name: string; color: string }[];
  priority: number;
  due: string | null; // YYYY-MM-DD date-only
  dueLabel: string | null;
  overdue: boolean;
  assignee: string | null;
  milestoneId: string | null;
  milestoneName: string | null;
  waitingOn: string | null;
  waitingSince: string | null;
  blockedBy: number; // unfinished blockers, including ones the viewer cannot see
  hiddenBlockers: number;
  canMove: boolean;
};

export async function planningBoard(db: Db, v: Viewer, projectId: string, now = new Date()) {
  const columns = await db.planningColumn.findMany({ where: { projectId }, orderBy: { position: "asc" } });
  const items = await db.planningItem.findMany({
    where: await planningWhere(db, v, projectId),
    include: {
      column: true,
      milestone: true,
      workItem: { include: { repository: { select: { fullName: true, isDemo: true } } } },
      waiting: { where: { status: "PENDING" } },
      blockedBy: { include: { from: { include: { column: true } } } },
    },
    orderBy: [{ position: "asc" }],
  });
  const grants = v.isAdmin ? null : await db.repositoryGrant.findMany({ where: { memberId: v.memberId, revokedAt: null, canManageWork: true }, select: { repositoryId: true } });
  const manageable = new Set(grants?.map((g) => g.repositoryId));
  const visibleIds = new Set(
    (await db.planningItem.findMany({ where: await planningWhere(db, v, projectId), select: { id: true } })).map((i) => i.id),
  );
  const today = todayIn(v.timezone, now);
  const progress = await checklistProgress(db, items.map((i) => i.id));

  const cards: CardView[] = items.map((i) => {
    const unfinished = i.blockedBy.filter((l) => l.from.column.key !== "done");
    const w = i.waiting[0];
    return {
      id: i.id,
      checklist: progress.get(i.id) ?? { done: 0, total: 0 },
      columnKey: i.column.key,
      position: i.position,
      version: i.version,
      title: i.workItem?.title ?? i.title,
      isDraft: !i.workItemId,
      repoFullName: i.workItem?.repository.fullName ?? null,
      number: i.workItem?.number ?? null,
      workState: i.workItem?.state ?? null,
      href: i.workItem ? (i.workItem.type === "PULL_REQUEST" ? `/pull-requests/${i.workItem.id}` : `/issues/${i.workItem.id}`) : null,
      labels: i.workItem ? asLabels(i.workItem.labels) : [],
      priority: i.priority,
      due: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null,
      dueLabel: i.dueDate ? formatDateOnly(i.dueDate) : null,
      overdue: isOverdue(i.dueDate, i.column.key, today),
      assignee: i.assigneeLogin ?? (i.workItem ? ((i.workItem.assignees as unknown as string[])?.[0] ?? null) : null),
      milestoneId: i.milestoneId,
      milestoneName: i.milestone?.name ?? null,
      waitingOn: w?.reviewerRef ?? null,
      waitingSince: w?.startedAt.toISOString() ?? null,
      blockedBy: unfinished.length,
      hiddenBlockers: unfinished.filter((l) => !visibleIds.has(l.fromId)).length,
      canMove: v.isAdmin || !i.workItemId || manageable.has(i.workItem!.repositoryId),
    };
  });
  return { columns, cards };
}

/** Work items a viewer may attach to a card: open, in repositories of the project that they can manage. */
export async function attachableWorkItems(db: Db, v: Viewer, projectId: string) {
  return db.workItem.findMany({
    where: {
      state: "OPEN",
      repository: { AND: [repoWhere(v), { projects: { some: { projectId } } }, ...(v.isAdmin ? [] : [{ grants: { some: { memberId: v.memberId, revokedAt: null, canManageWork: true } } }])] },
      planningItems: { none: { projectId } },
    },
    select: { id: true, number: true, title: true, repository: { select: { fullName: true } } },
    orderBy: { updatedAtGh: "desc" },
    take: 100,
  });
}

export async function roadmap(db: Db, v: Viewer) {
  const { projectWhere } = await import("@/lib/authz/viewer");
  const milestones = await db.dashboardMilestone.findMany({
    where: { workspaceId: v.workspaceId, OR: [{ projectId: null }, { project: projectWhere(v) }] },
    include: { owner: { include: { user: true } }, repoLinks: { where: { repository: repoWhere(v) }, include: { repository: { select: { fullName: true } } } } },
    orderBy: [{ targetDate: "asc" }],
  });
  return milestones;
}
