import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { ValidationError } from "@/lib/errors";

/**
 * Versioned backup of what Mergeport OWNS, and a validated restore.
 *
 * Included: planning (projects, cards, columns, links, comments, checklists, milestones, epics, iterations, boards, history events),
 * review and waiting rules, fork mappings and decisions, labels, subscriptions, backports, availability, your saved views, notification
 * preferences, inbox/seen state, pending review drafts, and the edits still waiting to be sent.
 * Never included: credentials or sessions, local folder paths and worktree snapshots, caches, the upstream auto-updater's settings and runs
 * (`UpstreamUpdateConfig` holds a command that runs on this computer, so no backup can carry it in or out; a crafted file naming that table is ignored), anything GitHub owns (issues, pull
 * requests, reviews, checks), and the coordination repositories themselves.
 *
 * Restore is additive: it creates what is missing and updates what differs, never deletes, and shows a preview first. Rows that point
 * at a repository this computer does not track are skipped and listed, not guessed at.
 */
export const BACKUP_FORMAT = "mergeport-backup";
export const BACKUP_VERSION = 1;
const MAX_BYTES = 80 * 1024 * 1024;

type Entry = { table: string; delegate: string; /** Primary key columns: one "id", or the composite columns in Prisma's order. */ key: string[]; compound?: string; remap?: Record<string, "workspace" | "user" | "member" | "repo" | "self-optional-space"> };

// Parents before children, so a restore never meets a missing parent.
const ENTRIES: Entry[] = [
  { table: "Project", delegate: "project", key: ["id"], remap: { workspaceId: "workspace", spaceId: "self-optional-space" } },
  { table: "ProjectRepository", delegate: "projectRepository", key: ["projectId", "repositoryId"], compound: "projectId_repositoryId", remap: { repositoryId: "repo" } },
  { table: "PlanningColumn", delegate: "planningColumn", key: ["id"] },
  { table: "DashboardMilestone", delegate: "dashboardMilestone", key: ["id"], remap: { workspaceId: "workspace", ownerId: "member" } },
  { table: "Epic", delegate: "epic", key: ["id"] },
  { table: "Iteration", delegate: "iteration", key: ["id"] },
  { table: "PlanBoard", delegate: "planBoard", key: ["id"] },
  { table: "PlanningItem", delegate: "planningItem", key: ["id"], remap: { createdById: "member" } },
  { table: "PlanningLink", delegate: "planningLink", key: ["fromId", "toId"], compound: "fromId_toId" },
  { table: "TaskComment", delegate: "taskComment", key: ["id"] },
  { table: "TaskCheckItem", delegate: "taskCheckItem", key: ["id"] },
  { table: "PlanEvent", delegate: "planEvent", key: ["id"] },
  { table: "ReviewRule", delegate: "reviewRule", key: ["id"], remap: { workspaceId: "workspace", repositoryId: "repo" } },
  { table: "WaitingRule", delegate: "waitingRule", key: ["id"], remap: { workspaceId: "workspace", repositoryId: "repo" } },
  { table: "ForkMapping", delegate: "forkMapping", key: ["id"], remap: { forkRepoId: "repo", upstreamRepoId: "repo" } },
  { table: "UpstreamIssueTriage", delegate: "upstreamIssueTriage", key: ["id"] },
  { table: "BackportRecord", delegate: "backportRecord", key: ["id"] },
  { table: "LabelMap", delegate: "labelMap", key: ["id"], remap: { workspaceId: "workspace", repoKey: "repo" } },
  { table: "UpstreamSubscription", delegate: "upstreamSubscription", key: ["id"], remap: { workspaceId: "workspace" } },
  { table: "ReviewerAvailability", delegate: "reviewerAvailability", key: ["id"], remap: { workspaceId: "workspace" } },
  { table: "SavedFilter", delegate: "savedFilter", key: ["id"], remap: { userId: "user" } },
  { table: "NotificationPref", delegate: "notificationPref", key: ["userId"], remap: { userId: "user" } },
  { table: "InboxState", delegate: "inboxState", key: ["userId", "subjectType", "subjectId"], compound: "userId_subjectType_subjectId", remap: { userId: "user" } },
  { table: "SeenState", delegate: "seenState", key: ["userId", "workItemId"], compound: "userId_workItemId", remap: { userId: "user" } },
  { table: "ReviewDraft", delegate: "reviewDraft", key: ["id"], remap: { userId: "user" } },
];

/**
 * The rows of each table that belong to ONE workspace (and, for personal state, one person). An export reads nothing else, so a
 * database holding many workspaces never leaks one into another's backup. Every table in ENTRIES must have an entry here.
 */
const IN_PROJECT = (w: string) => ({ project: { workspaceId: w } });
const SCOPE: Record<string, (w: string, userId: string) => Record<string, unknown>> = {
  Project: (w) => ({ workspaceId: w }),
  ProjectRepository: IN_PROJECT,
  PlanningColumn: IN_PROJECT,
  DashboardMilestone: (w) => ({ workspaceId: w }),
  Epic: IN_PROJECT,
  Iteration: IN_PROJECT,
  PlanBoard: IN_PROJECT,
  PlanningItem: IN_PROJECT,
  PlanningLink: (w) => ({ from: IN_PROJECT(w) }),
  TaskComment: (w) => ({ item: IN_PROJECT(w) }),
  TaskCheckItem: (w) => ({ item: IN_PROJECT(w) }),
  PlanEvent: IN_PROJECT,
  ReviewRule: (w) => ({ workspaceId: w }),
  WaitingRule: (w) => ({ workspaceId: w }),
  ForkMapping: (w) => ({ fork: { workspaceId: w } }),
  UpstreamIssueTriage: (w) => ({ mapping: { fork: { workspaceId: w } } }),
  BackportRecord: (w) => ({ mapping: { fork: { workspaceId: w } } }),
  LabelMap: (w) => ({ workspaceId: w }),
  UpstreamSubscription: (w) => ({ workspaceId: w }),
  ReviewerAvailability: (w) => ({ workspaceId: w }),
  SavedFilter: (_w, u) => ({ userId: u }),
  NotificationPref: (_w, u) => ({ userId: u }),
  InboxState: (_w, u) => ({ userId: u }),
  SeenState: (_w, u) => ({ userId: u }),
  ReviewDraft: (_w, u) => ({ userId: u }),
};

/** Columns that must never travel, whatever a table holds. A final guard behind the table list. */
const FORBIDDEN = /(^|_)(token|secret|password|rootPath|path)$/i;
const PATH_OK = new Set(["path"]); // a repository-relative file path in a review draft is content, not a local folder

const tag = (_k: string, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v instanceof Date ? { $d: v.toISOString() } : v);
const untag = (_k: string, v: unknown) => {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$b === "string" && Object.keys(o).length === 1) return BigInt(o.$b);
    if (typeof o.$d === "string" && Object.keys(o).length === 1) return new Date(o.$d);
  }
  return v;
};

const Envelope = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int(),
  exportedAt: z.string(),
  app: z.object({ migration: z.string() }),
  source: z.object({ workspaceId: z.string(), userLogin: z.string(), unsentEdits: z.number().int().nonnegative() }),
  repositories: z.array(z.object({ id: z.string(), githubId: z.string(), fullName: z.string() })).max(5000),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(500_000)),
  outbox: z.array(z.record(z.string(), z.unknown())).max(100_000),
});
export type Backup = z.infer<typeof Envelope>;

export const latestMigration = () => {
  try {
    const dir = path.join(process.cwd(), "prisma", "migrations");
    return fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort().at(-1) ?? "unknown";
  } catch {
    return "unknown";
  }
};

async function columns(db: Db, table: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

export async function exportBackup(db: Db, v: Viewer, now = new Date()): Promise<string> {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can export a backup");
  const repos = await db.repository.findMany({ where: { workspaceId: v.workspaceId, isDemo: false }, select: { id: true, githubId: true, fullName: true } });
  const tables: Backup["tables"] = {};
  for (const e of ENTRIES) {
    const cols = (await columns(db, e.table)).filter((c) => !FORBIDDEN.test(c) || (e.table === "ReviewDraft" && PATH_OK.has(c)));
    const rows = await (db as never as Record<string, { findMany(a: unknown): Promise<Record<string, unknown>[]> }>)[e.delegate].findMany({ where: SCOPE[e.table](v.workspaceId, v.userId) });
    tables[e.table] = rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
  }
  // Rows of other people's personal state never belong in this person's backup.
  tables.SavedFilter = (tables.SavedFilter ?? []).filter((r) => r.userId === v.userId);
  for (const t of ["NotificationPref", "InboxState", "SeenState", "ReviewDraft"]) tables[t] = (tables[t] ?? []).filter((r) => r.userId === v.userId);
  const ops = await db.outboxOp.findMany({ where: { status: { in: ["PENDING", "FAILED", "SENT", "QUARANTINED"] }, space: { workspaceId: v.workspaceId } } });
  const spaces = new Map((await db.space.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true, repoOwner: true, repoName: true, remoteId: true } })).map((s) => [s.id, s]));
  const outbox = ops.map((o) => ({ id: o.id, entityType: o.entityType, entityId: o.entityId, kind: o.kind, data: o.data, baseVersion: o.baseVersion, status: o.status, space: spaces.get(o.spaceId)?.remoteId ?? null }));
  const bundle: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    app: { migration: latestMigration() },
    source: { workspaceId: v.workspaceId, userLogin: v.login, unsentEdits: outbox.length },
    repositories: repos.map((r) => ({ id: r.id, githubId: r.githubId.toString(), fullName: r.fullName })),
    tables,
    outbox,
  };
  return JSON.stringify(bundle, tag);
}

export function parseBackup(text: string): Backup {
  if (text.length > MAX_BYTES) throw new ValidationError("That file is too large to be a Mergeport backup");
  let raw: unknown;
  try {
    raw = JSON.parse(text, untag);
  } catch {
    throw new ValidationError("That file is not a Mergeport backup (it is not valid JSON)");
  }
  const r = Envelope.safeParse(raw);
  if (!r.success) throw new ValidationError("That file is not a Mergeport backup, or it is damaged");
  if (r.data.version > BACKUP_VERSION) throw new ValidationError(`This backup was made by a newer Mergeport (format ${r.data.version}). Update the app to restore it`);
  if (r.data.app.migration > latestMigration() && latestMigration() !== "unknown") throw new ValidationError("This backup contains data from a newer version of the database than this app understands. Update the app to restore it");
  return r.data;
}

export type TablePreview = { table: string; create: number; update: number; same: number; skipped: number };
export type RestorePreview = { exportedAt: string; from: string; unsentEdits: number; tables: TablePreview[]; skipped: { table: string; why: string; count: number }[]; outbox: { restorable: number; skipped: number }; notes: string[] };

type Maps = { workspaceId: string; userId: string; memberId: string; repoById: Map<string, string>; spaceByRemote: Map<string, string>; spaces: Set<string> };

async function mapsFor(db: Db, v: Viewer, b: Backup): Promise<Maps> {
  const local = new Map((await db.repository.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true, githubId: true } })).map((r) => [r.githubId.toString(), r.id]));
  const repoById = new Map<string, string>();
  for (const r of b.repositories) {
    const id = local.get(r.githubId);
    if (id) repoById.set(r.id, id);
  }
  const spaces = await db.space.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true, remoteId: true } });
  return { workspaceId: v.workspaceId, userId: v.userId, memberId: v.memberId, repoById, spaceByRemote: new Map(spaces.map((s) => [s.remoteId, s.id])), spaces: new Set(spaces.map((s) => s.id)) };
}

function remapRow(e: Entry, row: Record<string, unknown>, m: Maps): { row: Record<string, unknown> } | { skip: string } {
  const out = { ...row };
  for (const [col, kind] of Object.entries(e.remap ?? {})) {
    const val = out[col];
    if (val === null || val === undefined || val === "") continue;
    if (kind === "workspace") out[col] = m.workspaceId;
    else if (kind === "user") out[col] = m.userId;
    else if (kind === "member") out[col] = m.memberId;
    else if (kind === "repo") {
      const to = m.repoById.get(String(val));
      if (!to) return { skip: "its repository is not tracked on this computer" };
      out[col] = to;
    } else if (kind === "self-optional-space") out[col] = m.spaces.has(String(val)) ? val : null;
  }
  return { row: out };
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]) => cols.every((c) => JSON.stringify(a[c] ?? null, tag) === JSON.stringify(b[c] ?? null, tag));

async function pass(db: Db, v: Viewer, b: Backup, write: boolean): Promise<RestorePreview> {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can restore a backup");
  const m = await mapsFor(db, v, b);
  const tables: TablePreview[] = [];
  const skipped = new Map<string, number>();
  // Projects this workspace owns (plus the ones this restore creates): a row of a child table may only name one of them.
  const ownProjects = new Set((await db.project.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true } })).map((p) => p.id));
  const restoredItems = new Set<string>();
  const ownsItem = async (id: unknown) => typeof id === "string" && (restoredItems.has(id) || (await db.planningItem.count({ where: { id, project: { workspaceId: v.workspaceId } } })) > 0);
  for (const e of ENTRIES) {
    const rows = b.tables[e.table] ?? [];
    const cols = await columns(db, e.table);
    const t: TablePreview = { table: e.table, create: 0, update: 0, same: 0, skipped: 0 };
    const delegate = (db as never as Record<string, { findUnique(a: unknown): Promise<Record<string, unknown> | null>; findFirst(a: unknown): Promise<Record<string, unknown> | null>; create(a: unknown): Promise<unknown>; update(a: unknown): Promise<unknown> }>)[e.delegate];
    for (const raw of rows) {
      const r = remapRow(e, Object.fromEntries(Object.entries(raw).filter(([c]) => cols.includes(c))), m);
      if ("skip" in r) {
        t.skipped++;
        skipped.set(`${e.table}|${r.skip}`, (skipped.get(`${e.table}|${r.skip}`) ?? 0) + 1);
        continue;
      }
      let row = r.row;
      if (typeof row.projectId === "string" && e.table !== "Project" && !ownProjects.has(row.projectId)) {
        t.skipped++;
        skipped.set(`${e.table}|belongs to another workspace`, (skipped.get(`${e.table}|belongs to another workspace`) ?? 0) + 1);
        continue;
      }
      // A card that followed a GitHub item is re-linked by the next sync (it keeps repository id and number); the local link is not guessed here.
      if (e.table === "PlanningItem") row = { ...row, workItemId: null };
      const itemRefs = e.table === "PlanningLink" ? [row.fromId, row.toId] : e.table === "TaskComment" || e.table === "TaskCheckItem" ? [row.itemId] : [];
      if (itemRefs.length && !(await Promise.all(itemRefs.map(ownsItem))).every(Boolean)) {
        t.skipped++;
        skipped.set(`${e.table}|belongs to another workspace`, (skipped.get(`${e.table}|belongs to another workspace`) ?? 0) + 1);
        continue;
      }
      const where = e.compound ? { [e.compound]: Object.fromEntries(e.key.map((k) => [k, row[k]])) } : { [e.key[0]]: row[e.key[0]] };
      const cur = await delegate.findUnique({ where });
      // A row with this key that exists but is not this workspace's (or this person's) is never touched: a crafted file cannot reach into another tenant.
      if (cur && !(await delegate.findFirst({ where: { AND: [Object.fromEntries(e.key.map((k) => [k, row[k]])), SCOPE[e.table](v.workspaceId, v.userId)] } }))) {
        t.skipped++;
        skipped.set(`${e.table}|belongs to another workspace`, (skipped.get(`${e.table}|belongs to another workspace`) ?? 0) + 1);
        continue;
      }
      if (e.table === "Project") ownProjects.add(String(row.id));
      if (e.table === "PlanningItem") restoredItems.add(String(row.id));
      if (!cur) {
        t.create++;
        if (write) await delegate.create({ data: row });
      } else if (same(cur, row, Object.keys(row))) t.same++;
      else {
        t.update++;
        if (write) await delegate.update({ where, data: Object.fromEntries(Object.entries(row).filter(([c]) => !e.key.includes(c))) });
      }
    }
    tables.push(t);
  }
  let restorable = 0;
  let skippedOps = 0;
  for (const o of b.outbox) {
    const spaceId = typeof o.space === "string" ? m.spaceByRemote.get(o.space) : undefined;
    if (!spaceId) {
      skippedOps++;
      continue;
    }
    restorable++;
    if (write && !(await db.outboxOp.findUnique({ where: { id: String(o.id) } }))) {
      await db.outboxOp.create({ data: { id: String(o.id), spaceId, entityType: String(o.entityType), entityId: String(o.entityId), kind: o.kind === "DELETE" ? "DELETE" : "UPSERT", data: (o.data ?? undefined) as never, baseVersion: Number(o.baseVersion ?? 0), status: "PENDING" } });
    }
  }
  return {
    exportedAt: b.exportedAt,
    from: `@${b.source.userLogin}`,
    unsentEdits: b.source.unsentEdits,
    tables: tables.filter((t) => t.create + t.update + t.same + t.skipped > 0),
    skipped: [...skipped].map(([k, count]) => ({ table: k.split("|")[0], why: k.split("|")[1], count })),
    outbox: { restorable, skipped: skippedOps },
    notes: [
      "Restoring adds missing records and updates ones that differ. It never deletes anything.",
      "Records are matched by id. A record you changed since the backup is overwritten by the backup's version, so preview first.",
      ...(skippedOps > 0 ? [`${skippedOps} unsent edit${skippedOps === 1 ? "" : "s"} belong to a team space that is not set up on this computer, so they were not restored.`] : []),
      "Credentials, folder paths and anything GitHub owns are not in a backup and are not touched.",
    ],
  };
}

export const previewRestore = (db: Db, v: Viewer, b: Backup) => pass(db, v, b, false);

/** Applies the restore in one transaction: it all happens or none of it does. */
export async function restoreBackup(db: Db, v: Viewer, b: Backup, opts: { confirmed: boolean }): Promise<RestorePreview> {
  if (!opts.confirmed) throw new ValidationError("Confirm the restore before it is applied");
  return db.$transaction(async (tx) => pass(tx as unknown as Db, v, b, true), { timeout: 120_000, maxWait: 10_000 });
}
