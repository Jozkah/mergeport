import type { Db } from "@/lib/db";
import { requireProject, type Viewer } from "@/lib/authz/viewer";
import { agingWip, cycleTimes, recordingSince, scopeAdded, type Aging, type CycleTime } from "@/lib/domain/analytics";
import { blockerFinished, criticalBlockers, isLinkKind, layers, type LinkKind } from "@/lib/domain/deps";
import { planningWhere } from "./queries";

// ---------- dependency graph ----------

export type GraphNode = { id: string; title: string; column: string; projectId: string; projectName: string; finished: boolean; layer: number; holdsBack: number };
export type GraphEdge = { from: string; to: string; kind: LinkKind };
export type OpaqueEdge = { kind: LinkKind; direction: "blocks" | "blocked-by"; visibleEnd: string };
export type DependencyGraph = { nodes: GraphNode[]; edges: GraphEdge[]; opaque: OpaqueEdge[]; critical: GraphNode[] };

/**
 * The links among cards the viewer can see, across projects. A link to a card they cannot see is not drawn as a node: it appears
 * only as an anonymous marker on the visible end ("blocked by something you cannot see"), with no id, title or project.
 */
export async function dependencyGraph(db: Db, v: Viewer, opts: { projectId?: string } = {}): Promise<DependencyGraph> {
  if (opts.projectId) await requireProject(db, v, opts.projectId);
  const where = await planningWhere(db, v, opts.projectId);
  const items = await db.planningItem.findMany({ where, include: { column: true, project: { select: { name: true } }, workItem: { select: { type: true, state: true, title: true } } } });
  const visible = new Map(items.map((i) => [i.id, i]));
  const ids = [...visible.keys()];
  const links = await db.planningLink.findMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] }, include: { from: { include: { column: true, workItem: { select: { type: true, state: true } } } } } });
  const edges: GraphEdge[] = [];
  const opaque: OpaqueEdge[] = [];
  for (const l of links) {
    const kind: LinkKind = isLinkKind(l.kind) ? l.kind : "blocks";
    const a = visible.has(l.fromId);
    const b = visible.has(l.toId);
    if (a && b) edges.push({ from: l.fromId, to: l.toId, kind });
    else if (a && !b) opaque.push({ kind, direction: "blocks", visibleEnd: l.fromId });
    else if (!a && b) opaque.push({ kind, direction: "blocked-by", visibleEnd: l.toId });
  }
  const finished = (id: string) => {
    const i = visible.get(id)!;
    return blockerFinished({ columnKey: i.column.key, workType: i.workItem?.type ?? null, workState: i.workItem?.state ?? null });
  };
  const connected = new Set([...edges.flatMap((e) => [e.from, e.to]), ...opaque.map((o) => o.visibleEnd)]);
  const crit = new Map(criticalBlockers([...connected].map((id) => ({ id, finished: finished(id) })), edges).map((c) => [c.id, c.holdsBack]));
  const layerOf = layers([...connected], edges);
  const nodes: GraphNode[] = [...connected].map((id) => {
    const i = visible.get(id)!;
    return { id, title: i.workItem?.title ?? i.title, column: i.column.name ?? i.column.key, projectId: i.projectId, projectName: i.project.name, finished: finished(id), layer: layerOf.get(id) ?? 0, holdsBack: crit.get(id) ?? 0 };
  });
  return { nodes, edges, opaque, critical: nodes.filter((n) => n.holdsBack > 0).sort((a, b) => b.holdsBack - a.holdsBack).slice(0, 5) };
}

// ---------- delivery analytics ----------

export type Analytics = {
  /** When recording began for this project, or null when nothing has been recorded yet. */
  recordingSince: Date | null;
  events: number;
  cycle: CycleTime;
  aging: Aging[];
  agingUnrecorded: number;
  reviewWait: { count: number; medianMs: number | null };
  scope: { milestoneId: string; name: string; added: number; atStart: number }[];
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Cycle time, aging work in progress, review wait and scope added after planning, from recorded events only. Review wait uses
 * real review facts (when a review was first seen requested, and when that person's first review on it was submitted).
 */
export async function deliveryAnalytics(db: Db, v: Viewer, projectId: string, now = new Date()): Promise<Analytics> {
  await requireProject(db, v, projectId);
  const visibleIds = (await db.planningItem.findMany({ where: await planningWhere(db, v, projectId), select: { id: true } })).map((i) => i.id);
  const visible = new Set(visibleIds);
  // Only events about cards the viewer can see: a hidden card's history is as private as the card.
  const events = (await db.planEvent.findMany({ where: { projectId }, orderBy: { at: "asc" } })).filter((e) => visible.has(e.itemId));
  const evs = events.map((e) => ({ itemId: e.itemId, kind: e.kind, fromKey: e.fromKey, toKey: e.toKey, refId: e.refId, at: e.at }));
  const open = await db.planningItem.findMany({ where: { id: { in: visibleIds } }, select: { id: true, column: { select: { key: true } } } });
  const { aging, unrecorded } = agingWip(open.map((i) => ({ id: i.id, columnKey: i.column.key })), evs, now);

  const cards = await db.planningItem.findMany({ where: { id: { in: visibleIds }, workItemId: { not: null } }, select: { workItem: { select: { id: true, type: true, reviewRequests: { select: { reviewerRef: true, requestedAt: true, kind: true } }, comments: { where: { kind: "REVIEW" }, select: { authorLogin: true, createdAtGh: true } } } } } });
  const waits: number[] = [];
  for (const c of cards) {
    const w = c.workItem;
    if (!w || w.type !== "PULL_REQUEST") continue;
    for (const r of w.reviewRequests.filter((x) => x.kind === "USER")) {
      const first = w.comments.filter((x) => x.authorLogin?.toLowerCase() === r.reviewerRef.toLowerCase() && x.createdAtGh >= r.requestedAt).sort((a, b) => a.createdAtGh.getTime() - b.createdAtGh.getTime())[0];
      if (first) waits.push(first.createdAtGh.getTime() - r.requestedAt.getTime());
    }
  }
  const milestones = await db.dashboardMilestone.findMany({ where: { workspaceId: v.workspaceId, OR: [{ projectId }, { projectId: null }], startDate: { not: null } } });
  const scope = milestones.flatMap((m) => {
    const s = scopeAdded(evs, m.id, m.startDate);
    return s && s.added + s.atStart > 0 ? [{ milestoneId: m.id, name: m.name, ...s }] : [];
  });
  return { recordingSince: recordingSince(evs), events: evs.length, cycle: cycleTimes(evs), aging, agingUnrecorded: unrecorded, reviewWait: { count: waits.length, medianMs: waits.length ? median(waits) : null }, scope };
}
