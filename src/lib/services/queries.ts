import { byOwnerFirst, byPersonalFirst } from "@/lib/domain/ordering";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { projectWhere, repoWhere, viaRepo, type Viewer } from "@/lib/authz/viewer";
import { deriveReview, type ReviewDerivation, type ReviewInput, type Reviewer } from "@/lib/domain/review";
import { resolveRule, type RuleRow } from "@/lib/domain/rules";
import { applyWaitingRules, matchingWaitingRules, type WaitingRuleRow } from "@/lib/domain/waiting-rules";
import { isOverdue, todayIn } from "@/lib/domain/planning";
import { indexNeedle } from "@/lib/domain/text-index";
import { deriveStages, type StageEntry } from "@/lib/domain/stages";

/**
 * Every query here starts from the viewer's repository filter. Counts, charts, search and
 * lists are computed AFTER scoping, never fetched whole and trimmed in the browser.
 */

export type Label = { name: string; color: string };

export const asLabels = (j: unknown): Label[] => (Array.isArray(j) ? (j as Label[]) : []);
export const asStrings = (j: unknown): string[] => (Array.isArray(j) ? (j as string[]) : []);

// ---------- rule + derivation plumbing ----------

async function loadRuleContext(db: Db, v: Viewer) {
  const [rules, waitingRules, members, projectLinks] = await Promise.all([
    db.reviewRule.findMany({ where: { workspaceId: v.workspaceId } }),
    db.waitingRule.findMany({ where: { workspaceId: v.workspaceId, enabled: true } }),
    db.member.findMany({ where: { workspaceId: v.workspaceId, status: "ACTIVE" }, include: { user: { select: { login: true } } } }),
    db.projectRepository.findMany({ where: { project: { workspaceId: v.workspaceId } } }),
  ]);
  const ruleRows: RuleRow[] = rules.map((r) => ({
    id: r.id,
    scope: r.scope,
    repositoryId: r.repositoryId,
    ownerLogin: r.ownerLogin,
    projectId: r.projectId,
    labels: asStrings(r.labels),
    reviewers: (r.reviewers as unknown as Reviewer[]) ?? [],
    semantics: r.semantics,
    reason: r.reason,
    enabled: r.enabled,
  }));
  const internalLogins = new Set(members.map((m) => m.user.login.toLowerCase()));
  const projectsByRepo = new Map<string, string[]>();
  for (const l of projectLinks) (projectsByRepo.get(l.repositoryId) ?? projectsByRepo.set(l.repositoryId, []).get(l.repositoryId)!).push(l.projectId);
  const waitingRows: WaitingRuleRow[] = waitingRules.map((r) => ({
    id: r.id,
    scope: r.scope,
    repositoryId: r.repositoryId,
    ownerLogin: r.ownerLogin,
    projectId: r.projectId,
    itemType: (r.itemType === "ISSUE" || r.itemType === "ANY" ? r.itemType : "PULL_REQUEST") as WaitingRuleRow["itemType"],
    labels: asStrings(r.labels),
    authors: asStrings(r.authors),
    includeDrafts: r.includeDrafts,
    waitingOn: (r.waitingOn as unknown as Reviewer[]) ?? [],
    reason: r.reason,
    stage: r.stage,
    enabled: r.enabled,
  }));
  // Unfinished planning blockers per GitHub item. Hidden blockers count too (the count discloses nothing about them).
  // Policy: a blocker only holds back the item in the project where the link lives, so a project-scoped view counts that project's links only.
  const blockerLinks = await db.planningLink.findMany({
    where: { from: { column: { key: { not: "done" } } }, to: { workItemId: { not: null }, project: { workspaceId: v.workspaceId } } },
    select: { to: { select: { workItemId: true, projectId: true } } },
  });
  const blockers = new Map<string, { projectId: string }[]>();
  for (const l of blockerLinks) (blockers.get(l.to.workItemId!) ?? blockers.set(l.to.workItemId!, []).get(l.to.workItemId!)!).push({ projectId: l.to.projectId });
  return { ruleRows, waitingRows, internalLogins, projectsByRepo, blockers };
}

type PrRow = Prisma.WorkItemGetPayload<{ include: { repository: { include: { owner: true } }; comments: true; reviewRequests: true; waiting: true } }>;

export type DerivedItem = {
  item: PrRow;
  derivation: ReviewDerivation;
  ruleConflict: string | null;
  manualWaiting: PrRow["waiting"];
  /** Hand-off stages (internal review, external review, maintainer merge, upstream release), in order, each with its owner and age. */
  stages: StageEntry[];
  /** Unfinished planning blockers counted for this item (hidden ones included). */
  dependencyBlockers: number;
};

function deriveFor(row: PrRow, v: Viewer, now: Date, rc: Awaited<ReturnType<typeof loadRuleContext>>, contextProjectId?: string | null): DerivedItem {
  const labels = asLabels(row.labels).map((l) => l.name);
  const res = resolveRule(rc.ruleRows, {
    repositoryId: row.repositoryId,
    ownerLogin: row.repository.owner.login,
    labels,
    projectIds: rc.projectsByRepo.get(row.repositoryId) ?? [],
    contextProjectId,
  });
  const reviews = row.comments
    .filter((c) => c.kind === "REVIEW" && c.authorLogin && c.reviewState)
    .map((c) => ({ reviewer: c.authorLogin!, state: c.reviewState!, commitSha: c.commitSha, submittedAt: c.createdAtGh }));
  const manualWaiting = row.waiting.filter((w) => w.status === "PENDING" && w.source === "MANUAL");
  const input: ReviewInput = {
    type: row.type,
    state: row.state,
    draft: row.draft,
    authorLogin: row.authorLogin,
    headSha: row.headSha,
    checksState: row.checksState,
    mergeable: row.mergeable,
    reviews,
    requests: row.reviewRequests.filter((r) => !r.removedAt && r.kind !== "EXTERNAL_ROLE").map((r) => ({ kind: r.kind as "USER" | "TEAM", ref: r.reviewerRef, requestedAt: r.requestedAt })),
    cancelledRequests: row.reviewRequests.filter((r) => r.removedAt && r.kind !== "EXTERNAL_ROLE").map((r) => ({ kind: r.kind as "USER" | "TEAM", ref: r.reviewerRef, requestedAt: r.requestedAt })),
    rule: res.kind === "rule" ? res.rule : null,
    readyAt: row.createdAtGh,
    internalLogins: rc.internalLogins,
    blockedByDependencies: (rc.blockers.get(row.id) ?? []).filter((b) => !contextProjectId || b.projectId === contextProjectId).length,
    manuallyCleared: new Set(row.waiting.filter((w) => w.status === "SATISFIED" && w.reviewerKind === "EXTERNAL_ROLE").map((w) => w.reviewerRef)),
    now,
  };
  const matched = matchingWaitingRules(rc.waitingRows, { repositoryId: row.repositoryId, ownerLogin: row.repository.owner.login, projectIds: rc.projectsByRepo.get(row.repositoryId) ?? [], labels, authorLogin: row.authorLogin, type: row.type, draft: row.draft });
  const derivation = applyWaitingRules(deriveReview(input, v.login), input, matched, v.login);
  const stages = deriveStages({ derivation, input, matched, manual: row.waiting.map((w) => ({ stage: w.stage, reviewerKind: w.reviewerKind, reviewerRef: w.reviewerRef, reason: w.reason, startedAt: w.startedAt, status: w.status, source: w.source })), now });
  return { item: row, derivation, ruleConflict: res.kind === "conflict" ? res.message : null, manualWaiting, stages, dependencyBlockers: input.blockedByDependencies ?? 0 };
}

const prInclude = { repository: { include: { owner: true } }, comments: true, reviewRequests: true, waiting: true } as const;

export type AttentionQueues = {
  needsMyReview: DerivedItem[];
  needsTeamReview: DerivedItem[];
  waitingExternal: DerivedItem[];
  changesRequested: DerivedItem[];
  blocked: DerivedItem[];
  manualWaiting: DerivedItem[];
};

export async function attention(db: Db, v: Viewer, opts: { now?: Date; projectId?: string | null; repositoryIds?: string[] } = {}): Promise<AttentionQueues> {
  const now = opts.now ?? new Date();
  const rc = await loadRuleContext(db, v);
  const where: Prisma.WorkItemWhereInput = { ...viaRepo(v), state: "OPEN" };
  if (opts.repositoryIds) where.repositoryId = { in: opts.repositoryIds };
  const rows = await db.workItem.findMany({ where, include: prInclude, orderBy: { updatedAtGh: "desc" } });
  const derived = rows.map((r) => deriveFor(r, v, now, rc, opts.projectId));
  const q: AttentionQueues = { needsMyReview: [], needsTeamReview: [], waitingExternal: [], changesRequested: [], blocked: [], manualWaiting: [] };
  for (const d of derived) {
    if (d.derivation.queues.needsMyReview) q.needsMyReview.push(d);
    if (d.derivation.queues.needsTeamReview) q.needsTeamReview.push(d);
    if (d.derivation.queues.waitingExternal) q.waitingExternal.push(d);
    if (d.derivation.queues.changesRequestedForMe) q.changesRequested.push(d);
    if (d.derivation.queues.blocked) q.blocked.push(d);
    if (d.manualWaiting.length) q.manualWaiting.push(d);
  }
  return q;
}

// ---------- overview ----------

export async function overview(db: Db, v: Viewer, now = new Date()) {
  const q = await attention(db, v, { now });
  const base = viaRepo(v);
  const [openIssues, openPrs, forkRepos] = await Promise.all([
    db.workItem.count({ where: { ...base, state: "OPEN", type: "ISSUE" } }),
    db.workItem.count({ where: { ...base, state: "OPEN", type: "PULL_REQUEST" } }),
    db.forkMapping.findMany({
      where: { fork: repoWhere(v), upstream: repoWhere(v) }, // upstream content only if ALSO visible
      include: { comparisons: { orderBy: { comparedAt: "desc" }, take: 1 } },
    }),
  ]);
  const forksBehind = forkRepos.filter((m) => (m.comparisons[0]?.behindBy ?? 0) > 0).length;

  const items = await db.planningItem.findMany({
    where: await planningWhere(db, v),
    include: { column: true },
  });
  const today = todayIn(v.timezone, now);
  const blockedPlanning = items.filter((i) => i.column.key === "blocked").length;
  const overdue = items.filter((i) => isOverdue(i.dueDate, i.column.key, today)).length;

  return {
    needsMyReview: q.needsMyReview.length,
    waitingOnOthers: q.waitingExternal.length + q.needsTeamReview.filter((d) => !d.derivation.queues.needsMyReview).length,
    openIssues,
    openPrs,
    blockedOrOverdue: q.blocked.length + blockedPlanning + overdue,
    forksWithUpstreamWork: forksBehind,
    attentionPreview: q.needsMyReview.slice(0, 5),
  };
}

// ---------- planning scope ----------

/**
 * Planning items the viewer may see:
 *  - linked items inherit repository restrictions (viewer must see the repository);
 *  - draft items are visible to members of the project (explicit audience); admin sees all.
 */
export async function planningWhere(_db: Db, v: Viewer, projectId?: string): Promise<Prisma.PlanningItemWhereInput> {
  const projectFilter: Prisma.PlanningItemWhereInput = { project: { workspaceId: v.workspaceId, ...(projectId ? { id: projectId } : {}) } };
  if (v.isAdmin) return projectFilter;
  return {
    AND: [
      projectFilter,
      { project: projectWhere(v) },
      {
        OR: [
          { workItemId: null, project: { members: { some: { memberId: v.memberId } } } },
          { workItem: { is: { repository: repoWhere(v) } } },
        ],
      },
    ],
  };
}

// ---------- work item lists ----------

export type WorkItemListParams = {
  type?: "ISSUE" | "PULL_REQUEST";
  state?: "OPEN" | "CLOSED" | "MERGED" | "ALL";
  repositoryIds?: string[];
  projectId?: string;
  label?: string;
  assignee?: string;
  author?: string;
  q?: string;
  sort?: "updated" | "created" | "number" | "title";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export async function listWorkItems(db: Db, v: Viewer, p: WorkItemListParams) {
  const and: Prisma.WorkItemWhereInput[] = [viaRepo(v)];
  if (p.type) and.push({ type: p.type });
  const state = p.state ?? "OPEN";
  if (state !== "ALL") and.push({ state });
  if (p.repositoryIds?.length) and.push({ repositoryId: { in: p.repositoryIds } }); // intersected with viaRepo above
  if (p.projectId) and.push({ repository: { projects: { some: { projectId: p.projectId } } } });
  if (p.label) and.push({ labelNames: { contains: indexNeedle(p.label) } });
  if (p.assignee) and.push({ assigneeLogins: { contains: indexNeedle(p.assignee) } });
  if (p.author) and.push({ authorLogin: { contains: p.author } }); // SQLite LIKE: case-insensitive substring
  if (p.q) and.push({ OR: [{ title: { contains: p.q } }, ...(Number.isInteger(Number(p.q)) ? [{ number: Number(p.q) }] : [])] });
  const where: Prisma.WorkItemWhereInput = { AND: and };

  const pageSize = Math.min(Math.max(p.pageSize ?? 25, 1), 100);
  const page = Math.max(p.page ?? 1, 1);
  const dir = p.dir ?? "desc";
  const orderBy: Prisma.WorkItemOrderByWithRelationInput =
    p.sort === "created" ? { createdAtGh: dir } : p.sort === "number" ? { number: dir } : p.sort === "title" ? { title: dir } : { updatedAtGh: dir };

  const [total, rows] = await Promise.all([
    db.workItem.count({ where }),
    db.workItem.findMany({ where, orderBy: [orderBy, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, include: { repository: { include: { owner: true } } } }),
  ]);
  return { total, page, pageSize, rows };
}

export async function getWorkItemDetail(db: Db, v: Viewer, id: string) {
  const item = await db.workItem.findFirst({
    where: { id, ...viaRepo(v) },
    include: { repository: { include: { owner: true } }, comments: { orderBy: { createdAtGh: "asc" } }, reviewRequests: true, waiting: true },
  });
  if (!item) throw new NotFoundError();
  return item;
}

export async function derivedDetail(db: Db, v: Viewer, id: string, now = new Date()) {
  const row = await db.workItem.findFirst({ where: { id, ...viaRepo(v) }, include: prInclude });
  if (!row) throw new NotFoundError();
  const rc = await loadRuleContext(db, v);
  return deriveFor(row, v, now, rc);
}

// ---------- search ----------

export async function searchGlobal(db: Db, v: Viewer, q: string) {
  const term = q.trim();
  if (term.length < 2) return { repositories: [], workItems: [], planning: [] };
  const [repositories, workItems, planning] = await Promise.all([
    db.repository.findMany({ where: { AND: [repoWhere(v), { fullName: { contains: term } }] }, take: 6, select: { id: true, fullName: true } }),
    db.workItem.findMany({
      where: { AND: [viaRepo(v), { OR: [{ title: { contains: term } }, ...(Number.isInteger(Number(term)) ? [{ number: Number(term) }] : [])] }] },
      take: 8,
      orderBy: { updatedAtGh: "desc" },
      select: { id: true, number: true, title: true, type: true, repository: { select: { fullName: true } } },
    }),
    db.planningItem.findMany({ where: { AND: [await planningWhere(db, v), { title: { contains: term } }] }, take: 5, select: { id: true, title: true, projectId: true } }),
  ]);
  return { repositories, workItems, planning };
}

// ---------- repositories / projects ----------

export async function listRepositories(db: Db, v: Viewer) {
  const rows = await db.repository.findMany({
    where: repoWhere(v),
    include: {
      owner: true,
      projects: { where: { project: projectWhereForNames(v) }, include: { project: { select: { id: true, name: true } } } },
      _count: { select: { workItems: { where: { state: "OPEN" } } } },
    },
    orderBy: { fullName: "asc" },
  });
  const first = byOwnerFirst(v.login); // the person's own repositories before teams' and other people's
  return rows.sort((a, b) => first(a.fullName, b.fullName));
}

/** Project names are only exposed to members who belong to that project. Admin sees all. */
function projectWhereForNames(v: Viewer): Prisma.ProjectWhereInput {
  return v.isAdmin ? { workspaceId: v.workspaceId } : { workspaceId: v.workspaceId, members: { some: { memberId: v.memberId } } };
}

export async function listProjects(db: Db, v: Viewer) {
  const projects = await db.project.findMany({ where: projectWhere(v), orderBy: { name: "asc" }, include: { repositories: { include: { repository: { select: { id: true, trackingStatus: true, workspaceId: true } } } } } });
  const visible = new Set((await db.repository.findMany({ where: repoWhere(v), select: { id: true } })).map((r) => r.id));
  // repoCount counts only repositories the viewer can see, never the project's global total.
  const first = byPersonalFirst(v.login);
  return projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug, repoCount: p.repositories.filter((r) => visible.has(r.repositoryId)).length })).sort((a, b) => first(a.name, b.name));
}

// ---------- overview helpers (all scoped) ----------

/** Items opened per local calendar day, from synchronized history only. */
export async function openedPerDay(db: Db, v: Viewer, days = 14, now = new Date()) {
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const rows = await db.workItem.findMany({ where: { ...viaRepo(v), createdAtGh: { gte: from } }, select: { createdAtGh: true } });
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) buckets.set(todayIn(v.timezone, new Date(now.getTime() - i * 24 * 3600 * 1000)), 0);
  for (const r of rows) {
    const k = todayIn(v.timezone, r.createdAtGh);
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

export type ActivityEvent = { id: string; at: Date; text: string; actor: string | null; repo: string; href: string };

export async function recentActivity(db: Db, v: Viewer, take = 20): Promise<ActivityEvent[]> {
  const [comments, items] = await Promise.all([
    db.workItemComment.findMany({ where: { workItem: viaRepo(v), kind: { in: ["ISSUE_COMMENT", "REVIEW"] } }, orderBy: { createdAtGh: "desc" }, take, include: { workItem: { select: { id: true, number: true, title: true, type: true, repository: { select: { fullName: true } } } } } }),
    db.workItem.findMany({ where: viaRepo(v), orderBy: { createdAtGh: "desc" }, take, include: { repository: { select: { fullName: true } } } }),
  ]);
  const href = (i: { id: string; type: string }) => (i.type === "PULL_REQUEST" ? `/pull-requests/${i.id}` : `/issues/${i.id}`);
  const ev: ActivityEvent[] = [
    ...comments.map((c) => ({
      id: "c" + c.id,
      at: c.createdAtGh,
      actor: c.authorLogin,
      repo: c.workItem.repository.fullName,
      href: href(c.workItem),
      text: c.kind === "REVIEW" ? `${c.reviewState === "APPROVED" ? "approved" : c.reviewState === "CHANGES_REQUESTED" ? "requested changes on" : "reviewed"} #${c.workItem.number} ${c.workItem.title}` : `commented on #${c.workItem.number} ${c.workItem.title}`,
    })),
    ...items.map((i) => ({ id: "i" + i.id, at: i.createdAtGh, actor: i.authorLogin, repo: i.repository.fullName, href: href(i), text: `opened ${i.type === "PULL_REQUEST" ? "pull request" : "issue"} #${i.number} ${i.title}` })),
  ];
  return ev.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
}

/** Fork mappings where BOTH sides are visible to the viewer; a visible fork never discloses a hidden upstream. */
export async function visibleForkMappings(db: Db, v: Viewer) {
  return db.forkMapping.findMany({
    where: { fork: repoWhere(v), upstream: repoWhere(v) },
    include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } }, comparisons: { orderBy: { comparedAt: "desc" }, take: 1 } },
    orderBy: { fork: { fullName: "asc" } },
  });
}

export async function unreadNotificationCount(db: Db, v: Viewer) {
  // Notifications tied to a repository are only counted while the viewer still has access to it.
  return db.notification.count({ where: { userId: v.userId, readAt: null, OR: [{ repositoryId: null }, { repositoryId: { in: await visibleIds(db, v) } }] } });
}
async function visibleIds(db: Db, v: Viewer) {
  return (await db.repository.findMany({ where: repoWhere(v), select: { id: true } })).map((r) => r.id);
}
export async function listNotifications(db: Db, v: Viewer, take = 30) {
  return db.notification.findMany({ where: { userId: v.userId, OR: [{ repositoryId: null }, { repositoryId: { in: await visibleIds(db, v) } }] }, orderBy: { createdAt: "desc" }, take });
}

export async function deriveForIds(db: Db, v: Viewer, ids: string[], now = new Date(), contextProjectId?: string | null): Promise<Map<string, DerivedItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.workItem.findMany({ where: { id: { in: ids }, ...viaRepo(v) }, include: prInclude });
  const rc = await loadRuleContext(db, v);
  return new Map(rows.map((r) => [r.id, deriveFor(r, v, now, rc, contextProjectId)]));
}
