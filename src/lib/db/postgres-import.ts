import fs from "node:fs";
import path from "node:path";
import type { Db } from "@/lib/db";
import { indexList } from "@/lib/domain/text-index";

/**
 * One-way import of a legacy centralized (Postgres) Mergeport database into a local SQLite profile.
 *
 * It is deliberately conservative:
 *  - it reads ONLY the rows that belong to the person importing (`login`): their user, membership, grants, notifications
 *    and the repositories, work items and planning data they could already see;
 *  - credentials never come across (GithubConnection, Session, device token hashes are not modelled in the new schema);
 *  - machine-specific data (devices, local folder paths, worktree snapshots) is dropped: map folders again on this computer;
 *  - nothing is shared: imported repositories and projects are local only until the person shares them to a space;
 *  - the target must be empty, and rows are inserted table by table in foreign-key order.
 * The function is pure with respect to I/O: it takes already-fetched rows, so tests need no Postgres.
 */

type Scalar = "String" | "Int" | "BigInt" | "Boolean" | "DateTime" | "Json" | "Float" | "Decimal" | "Bytes";
export type FieldInfo = { name: string; type: Scalar | "Enum"; optional: boolean };
export type RelationInfo = { name: string; target: string; from: string[]; optional: boolean };
export type ModelInfo = { name: string; fields: FieldInfo[]; relations: RelationInfo[]; id: string };

const SCALARS = new Set<string>(["String", "Int", "BigInt", "Boolean", "DateTime", "Json", "Float", "Decimal", "Bytes"]);

/** Reads model structure from the Prisma schema text (the generated client does not expose its DMMF here). */
export function parseSchema(text: string): Map<string, ModelInfo> {
  const enums = new Set([...text.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]));
  const out = new Map<string, ModelInfo>();
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const info: ModelInfo = { name: m[1], fields: [], relations: [], id: "id" };
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const [name, typeRaw] = line.split(/\s+/);
      if (!name || !typeRaw) continue;
      const optional = typeRaw.endsWith("?");
      const list = typeRaw.endsWith("[]");
      const type = typeRaw.replace(/[?[\]]/g, "");
      if (SCALARS.has(type) && !list) {
        info.fields.push({ name, type: type as Scalar, optional });
        if (/@id\b/.test(line)) info.id = name;
      } else if (enums.has(type) && !list) info.fields.push({ name, type: "Enum", optional });
      else if (!list) {
        const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(line);
        if (rel) info.relations.push({ name, target: type, from: rel[1].split(",").map((s) => s.trim()), optional });
      }
    }
    out.set(info.name, info);
  }
  return out;
}

export const loadSchema = (file = path.join(process.cwd(), "prisma", "schema.prisma")) => parseSchema(fs.readFileSync(file, "utf8"));

/** Tables that exist in the legacy database but must never be imported, even if a same-named model appears later. */
const NEVER = new Set(["Session", "Job", "PublicCacheEntry", "Device", "DeviceRepoMapping", "WorktreeSnapshot", "GithubConnection", "Invitation", "RepoProposal", "WebhookDelivery"]);

export type ImportReport = { imported: Record<string, number>; dropped: Record<string, number>; ignoredTables: string[]; warnings: string[] };
export type LegacyRows = Record<string, Record<string, unknown>[]>;

function coerce(f: FieldInfo, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "BigInt": return BigInt(v as string | number | bigint);
    case "DateTime": return v instanceof Date ? v : new Date(v as string | number);
    case "Json": return typeof v === "string" ? safeJson(v) : v;
    case "Int": case "Float": return Number(v);
    case "Boolean": return v === true || v === "t" || v === "true" || v === 1;
    default: return v;
  }
}
const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return s; }
};

function order(models: Map<string, ModelInfo>, names: string[]): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  const visit = (n: string, stack: Set<string>) => {
    if (done.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const r of models.get(n)?.relations ?? []) if (names.includes(r.target) && r.target !== n) visit(r.target, stack);
    stack.delete(n);
    done.add(n);
    out.push(n);
  };
  for (const n of names) visit(n, new Set());
  return out;
}

const delegate = (db: Db, model: string) => (db as unknown as Record<string, { create(a: { data: Record<string, unknown> }): Promise<unknown>; count(): Promise<number> }>)[model.charAt(0).toLowerCase() + model.slice(1)];

export async function importLegacy(db: Db, models: Map<string, ModelInfo>, rows: LegacyRows, opts: { login: string }): Promise<ImportReport> {
  const report: ImportReport = { imported: {}, dropped: {}, ignoredTables: [], warnings: [] };
  const login = opts.login.toLowerCase();
  const user = (rows.User ?? []).find((u) => String(u.login).toLowerCase() === login);
  if (!user) throw new Error(`No user "${opts.login}" in the source database.`);
  if ((await delegate(db, "User").count()) > 0) throw new Error("The target database is not empty. Import into a fresh profile.");

  const present = Object.keys(rows).filter((t) => models.has(t) && !NEVER.has(t));
  report.ignoredTables = Object.keys(rows).filter((t) => !present.includes(t));
  const myMember = (rows.Member ?? []).find((m) => m.userId === user.id);
  const keep = new Map<string, Set<unknown>>();
  // A legacy non-administrator only ever saw repositories and projects they were granted / belonged to; keep exactly those.
  const legacyAdmin = myMember?.role === "ADMIN";
  const visibleRepos = new Set((rows.RepositoryGrant ?? []).filter((g) => g.memberId === myMember?.id && !g.revokedAt).map((g) => g.repositoryId));
  const myProjects = new Set((rows.ProjectMember ?? []).filter((m) => m.memberId === myMember?.id).map((m) => m.projectId));

  for (const model of order(models, present)) {
    const info = models.get(model)!;
    const ids = new Set<unknown>();
    keep.set(model, ids);
    let n = 0;
    let dropped = 0;
    for (const raw of rows[model] ?? []) {
      // Ownership: only this person's own rows of person-scoped tables.
      if (model === "User" && raw.id !== user.id) { dropped++; continue; }
      if (model === "Member" && raw.userId !== user.id) { dropped++; continue; }
      if (info.fields.some((f) => f.name === "userId") && model !== "User" && raw.userId !== user.id) { dropped++; continue; }
      if (info.fields.some((f) => f.name === "memberId") && model !== "Member" && myMember && raw.memberId !== myMember.id) { dropped++; continue; }

      if (model === "AuditLog" && raw.actorUserId !== user.id) { dropped++; continue; } // other people's activity is not yours to carry
      if (model === "Repository" && !legacyAdmin && !visibleRepos.has(raw.id)) { dropped++; continue; }
      if (model === "Project" && !legacyAdmin && !myProjects.has(raw.id)) { dropped++; continue; }

      const data: Record<string, unknown> = {};
      for (const f of info.fields) {
        if (!(f.name in raw)) continue;
        const v = coerce(f, raw[f.name]);
        if (v === null && !f.optional) continue; // let the schema default apply
        data[f.name] = v;
      }
      let orphan = false;
      for (const r of info.relations) {
        const parent = keep.get(r.target);
        for (const fk of r.from) {
          if (data[fk] === null || data[fk] === undefined || !parent || parent.has(raw[fk])) continue;
          // A reference to a PERSON can be dropped safely. A reference to CONTENT that was not kept (a repository or project this
          // person could not see) means the row itself must not come across, or it would surface without its parent.
          if (r.optional && (r.target === "Member" || r.target === "User")) data[fk] = null;
          else if (r.optional) orphan = true;
          else if (r.target === "Member" && myMember) data[fk] = myMember.id; // other people's authorship is attributed to you; their identity is not carried over
          else if (r.target === "User") data[fk] = user.id;
          else orphan = true;
        }
      }
      if (orphan) { dropped++; continue; }

      // Local-first adjustments.
      if (model === "Member") data.role = "ADMIN"; // sole owner of this local profile; team authority comes from GitHub spaces
      if (model === "Repository" || model === "Project") data.spaceId = null; // nothing becomes shared by migrating
      if (model === "WorkItem") {
        data.labelNames = indexList(((data.labels as { name: string }[] | null) ?? []).map((l) => l.name));
        data.assigneeLogins = indexList(((data.assignees as string[] | null) ?? []).map(String));
      }
      await delegate(db, model).create({ data });
      ids.add(raw[info.id]);
      n++;
    }
    report.imported[model] = n;
    if (dropped) report.dropped[model] = dropped;
  }
  if ((report.imported.Repository ?? 0) > 0 && !(report.imported.RepositoryGrant ?? 0)) report.warnings.push("No repository grants for this person were found; repositories were imported but may be hidden until tracked again.");
  return report;
}
