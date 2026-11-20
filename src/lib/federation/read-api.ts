import type { Db } from "@/lib/db";
import { projectWhere, requireProject, type Viewer } from "@/lib/authz/viewer";
import { planningWhere } from "@/lib/services/queries";

/**
 * What a linked instance may read. Every DTO is built by naming each field: a Prisma row is never returned as it is, so a column
 * added to a table tomorrow cannot leak through here. No email address, no token, no GitHub credential, no hub or session data,
 * and no internal id other than the opaque ids of the projects and cards themselves.
 *
 * Visibility is not decided here: the caller passes the Viewer of the GRANT's person in the GRANT's workspace, and every query uses
 * projectWhere / planningWhere (roles, project membership, restricted spaces, repository access), exactly as that person's own pages do.
 */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;
/** Most cards one board answer carries; `truncated` says so. */
export const BOARD_CARD_CAP = 500;
const DESCRIPTION_MAX = 4000;
const TITLE_MAX = 300;

export type MeDto = { workspace: { name: string }; role: string; scope: "read" };
export type ProjectDto = { id: string; name: string; slug: string; description: string | null };
export type ItemSummaryDto = { id: string; title: string; position: number; priority: number; dueDate: string | null; assignee: string | null; labels: string[]; linked: boolean };
export type ColumnDto = { key: string; name: string; position: number; items: ItemSummaryDto[] };
export type BoardDto = { project: ProjectDto; columns: ColumnDto[]; truncated: boolean };
export type TaskDto = { id: string; title: string; description: string | null; columnKey: string; columnName: string; position: number; priority: number; dueDate: string | null; assignee: string | null; labels: string[]; linked: boolean; createdAt: string; updatedAt: string };

export const pageSize = (raw: string | null): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Label names only (strings, or the `name` of a label object), at most 10, 40 characters each. */
function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const l of v) {
    const n = typeof l === "string" ? l : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name : null;
    if (n) out.push(clip(n, 40));
    if (out.length === 10) break;
  }
  return out;
}

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const toProject = (p: { id: string; name: string; slug: string; description: string | null }): ProjectDto => ({ id: p.id, name: p.name, slug: p.slug, description: p.description ? clip(p.description, DESCRIPTION_MAX) : null });

export function me(v: Viewer, workspaceName: string): MeDto {
  return { workspace: { name: workspaceName }, role: v.role, scope: "read" };
}

export async function workspaceName(db: Db, workspaceId: string): Promise<string> {
  return (await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } })).name;
}

export async function listProjectsDto(db: Db, v: Viewer, opts: { limit: number; cursor: string | null }): Promise<{ projects: ProjectDto[]; nextCursor: string | null }> {
  const rows = await db.project.findMany({
    where: projectWhere(v),
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, name: true, slug: true, description: true },
  });
  const page = rows.slice(0, opts.limit);
  return { projects: page.map(toProject), nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null };
}

const itemSelect = { id: true, title: true, position: true, priority: true, dueDate: true, assigneeLogin: true, labels: true, workItemId: true, workItem: { select: { title: true } } } as const;

export async function boardDto(db: Db, v: Viewer, projectId: string): Promise<BoardDto> {
  const project = await requireProject(db, v, projectId); // hidden and missing are the same NotFoundError
  const columns = await db.planningColumn.findMany({ where: { projectId: project.id }, orderBy: { position: "asc" }, select: { id: true, key: true, name: true, position: true } });
  const items = await db.planningItem.findMany({
    where: await planningWhere(db, v, project.id),
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: BOARD_CARD_CAP + 1,
    select: { ...itemSelect, columnId: true },
  });
  const shown = items.slice(0, BOARD_CARD_CAP);
  return {
    project: toProject(project),
    truncated: items.length > BOARD_CARD_CAP,
    columns: columns.map((c) => ({
      key: c.key,
      name: c.name,
      position: c.position,
      items: shown
        .filter((i) => i.columnId === c.id)
        .map((i) => ({ id: i.id, title: clip(i.workItem?.title ?? i.title, TITLE_MAX), position: i.position, priority: i.priority, dueDate: dateOnly(i.dueDate), assignee: i.assigneeLogin, labels: labelNames(i.labels), linked: i.workItemId !== null })),
    })),
  };
}

export async function tasksDto(db: Db, v: Viewer, projectId: string, opts: { limit: number; cursor: string | null }): Promise<{ tasks: TaskDto[]; nextCursor: string | null }> {
  const project = await requireProject(db, v, projectId);
  const rows = await db.planningItem.findMany({
    where: await planningWhere(db, v, project.id),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { ...itemSelect, description: true, createdAt: true, updatedAt: true, column: { select: { key: true, name: true } } },
  });
  const page = rows.slice(0, opts.limit);
  return {
    tasks: page.map((i) => ({
      id: i.id,
      title: clip(i.workItem?.title ?? i.title, TITLE_MAX),
      description: i.description ? clip(i.description, DESCRIPTION_MAX) : null,
      columnKey: i.column.key,
      columnName: i.column.name,
      position: i.position,
      priority: i.priority,
      dueDate: dateOnly(i.dueDate),
      assignee: i.assigneeLogin,
      labels: labelNames(i.labels),
      linked: i.workItemId !== null,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    })),
    nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null,
  };
}
