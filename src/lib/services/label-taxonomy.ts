import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { repoWhere, type Viewer } from "@/lib/authz/viewer";
import { families, parseScoped, previewMapping, type Family, type Mapping, type MigrationPreview } from "@/lib/domain/labels";
import { indexNeedle } from "@/lib/domain/text-index";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "./audit";

/** Optional scoped labels (`family::value`) and per-repository spellings that mean the same dashboard concept. Reading only: never rewrites labels on GitHub. */

export async function listMappings(db: Db, v: Viewer): Promise<(Mapping & { id: string })[]> {
  const rows = await db.labelMap.findMany({ where: { workspaceId: v.workspaceId }, orderBy: [{ concept: "asc" }, { spelling: "asc" }] });
  return rows.map((r) => ({ id: r.id, concept: r.concept, spelling: r.spelling, repositoryId: r.repoKey || null }));
}

export async function addMapping(db: Db, v: Viewer, input: { concept: string; spelling: string; repositoryId?: string | null }) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change label mappings");
  const s = parseScoped(input.concept);
  if (!s) throw new ValidationError("A concept looks like family::value, for example priority::high");
  const spelling = input.spelling.trim();
  if (!spelling || spelling.length > 80) throw new ValidationError("Enter the label as spelled in the repository");
  if (parseScoped(spelling)) throw new ValidationError("A scoped label already means itself. Map a plain spelling such as P1");
  let repoKey = "";
  if (input.repositoryId) {
    const r = await db.repository.findFirst({ where: { AND: [repoWhere(v), { id: input.repositoryId }] } });
    if (!r) throw new NotFoundError();
    repoKey = r.id;
  }
  if (await db.labelMap.findFirst({ where: { workspaceId: v.workspaceId, spelling: { equals: spelling }, repoKey } })) throw new ValidationError("That spelling is already mapped there");
  const m = await db.labelMap.create({ data: { workspaceId: v.workspaceId, concept: `${s.family}::${s.value}`, spelling, repoKey } });
  await audit(db, v, "labelmap.add", { type: "LabelMap", id: m.id });
  return m;
}

export async function deleteMapping(db: Db, v: Viewer, id: string) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change label mappings");
  const m = await db.labelMap.findFirst({ where: { id, workspaceId: v.workspaceId } });
  if (!m) throw new NotFoundError();
  await db.labelMap.delete({ where: { id } });
}

/** The taxonomy in use over the items this viewer can see, plus a preview of how the mappings change how items read. Counts only. */
export async function taxonomy(db: Db, v: Viewer): Promise<{ families: Family[]; preview: MigrationPreview; mappings: (Mapping & { id: string })[] }> {
  const mappings = await listMappings(db, v);
  const items = await db.workItem.findMany({ where: { repository: repoWhere(v) }, select: { repositoryId: true, labels: true }, take: 5000 });
  const rows = items.map((i) => ({ repositoryId: i.repositoryId, labels: ((i.labels as unknown as { name: string }[]) ?? []).map((l) => l.name) }));
  return { families: families(rows.flatMap((r) => r.labels), mappings), preview: previewMapping(rows, mappings), mappings };
}

/** A where-clause for "has this label or any spelling that means the same concept", used by the PR and issue lists. */
export async function labelFilter(db: Db, v: Viewer, label: string): Promise<Prisma.WorkItemWhereInput> {
  const mappings = (await listMappings(db, v)).filter((m) => m.concept.toLowerCase() === label.toLowerCase());
  const or: Prisma.WorkItemWhereInput[] = [{ labelNames: { contains: indexNeedle(label) } }];
  for (const m of mappings) or.push(m.repositoryId ? { AND: [{ labelNames: { contains: indexNeedle(m.spelling) } }, { repositoryId: m.repositoryId }] } : { labelNames: { contains: indexNeedle(m.spelling) } });
  return { OR: or };
}
