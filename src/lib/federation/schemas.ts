import { z } from "zod";

/**
 * What this instance accepts from a peer. The answer of another instance is untrusted input: it is parsed against these strict
 * shapes BEFORE it is cached or rendered. Unknown fields are stripped, strings and arrays are capped, ids must look like ids
 * (so one cannot carry a path or a query into a link), and anything else is refused as a whole. Mirrors the DTOs in read-api.ts.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;
const id = z.string().regex(ID_PATTERN);
const text = (max: number) => z.string().max(max);
const num = z.number().finite().min(-1e12).max(1e12);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = z.string().max(40);

const project = z.object({ id, name: text(300), slug: text(100), description: text(4000).nullable() });
const item = z.object({ id, title: text(300), position: num, priority: z.number().int().min(0).max(100000), dueDate: date.nullable(), assignee: text(100).nullable(), labels: z.array(text(40)).max(10), linked: z.boolean() });
const column = z.object({ key: text(100), name: text(300), position: num, items: z.array(item).max(500) });
const task = z.object({ id, title: text(300), description: text(4000).nullable(), columnKey: text(100), columnName: text(300), position: num, priority: z.number().int().min(0).max(100000), dueDate: date.nullable(), assignee: text(100).nullable(), labels: z.array(text(40)).max(10), linked: z.boolean(), createdAt: iso, updatedAt: iso });

export const MeSchema = z.object({ workspace: z.object({ name: text(120) }), role: text(20), scope: z.literal("read") });
export const ProjectsSchema = z.object({ projects: z.array(project).max(100), nextCursor: id.nullable() });
export const BoardSchema = z.object({ project, columns: z.array(column).max(50), truncated: z.boolean() });
export const TasksSchema = z.object({ tasks: z.array(task).max(100), nextCursor: id.nullable() });

/** The schema for a request path (without its query), or null for a path this version does not read. */
export function schemaFor(path: string): z.ZodType | null {
  const p = path.split("?")[0];
  if (p === "/me") return MeSchema;
  if (p === "/projects") return ProjectsSchema;
  if (/^\/projects\/[A-Za-z0-9_-]{1,60}$/.test(p)) return BoardSchema;
  if (/^\/projects\/[A-Za-z0-9_-]{1,60}\/tasks$/.test(p)) return TasksSchema;
  return null;
}

/** The validated, stripped body, or null when it does not fit. */
export function parsePeerBody(path: string, body: unknown): unknown | null {
  const schema = schemaFor(path);
  if (!schema) return null;
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}
