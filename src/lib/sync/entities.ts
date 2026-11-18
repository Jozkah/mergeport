import type { Prisma, Space } from "@/generated/prisma/client";
import { refreshHubWatch } from "@/lib/hub/watch";
import type { Db } from "@/lib/db";
import { createColumnsForProject } from "@/lib/services/planning";
import type { Data } from "./merge";
export type { Data };

/**
 * Mergeport-owned entities that live in coordination spaces, and how each maps onto the local read model.
 * Only Mergeport-owned data is listed here. GitHub conversations, reviews, labels, branches and commits are fetched
 * through the acting person's own access and cached locally; they are never written to a coordination repository.
 *
 * Contract for every type: serialize(local row) must round-trip through apply(), otherwise sync would invent edits.
 */

export const ENTITY_SCHEMA = 1;

export type Ctx = { workspaceId: string; localMemberId: string; space: Space; commonSpaceId: string | null };
export type Listed = { id: string; spaceId: string | null; data: Data };

/**
 * What apply() answers. `false`: a prerequisite entity is not materialized yet; the pull does not record the entity and retries it.
 * APPLY_INVALID: this entity can never be applied here (malformed, or it would take over a repository this person did not share into
 * the space); it is skipped, not recorded and not retried until the file changes. Anything else: applied.
 */
export const APPLY_INVALID = "invalid" as const;
export type ApplyOutcome = boolean | void | typeof APPLY_INVALID;

/** Entity ids this client accepts from a remote (file names and hub events alike). */
export const ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type EntityDef = {
  type: string;
  order: number;
  setKeys?: string[];
  list(db: Db, ctx: { commonSpaceId: string | null }): Promise<Listed[]>;
  /** See ApplyOutcome. Never throws for a malformed entity: `valid` rejects it first. */
  apply(db: Db, ctx: Ctx, id: string, data: Data | null, version: number): Promise<ApplyOutcome>;
  /** Shape check of a remote entity (data null: a deletion). Anything apply() would choke on is refused here. */
  valid?(id: string, data: Data | null): boolean;
  /** Runs once after every entity of this type in a pull has been applied (cross-entity links). */
  post?(db: Db, ctx: Ctx, applied: { id: string; data: Data }[]): Promise<void>;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: unknown) => (typeof s === "string" && s ? new Date(s.length === 10 ? s + "T00:00:00Z" : s) : null);
const repoEntityId = (githubId: bigint | string) => `repo-${githubId}`;
export const availabilityId = (login: string) => `avail-${login.toLowerCase()}`;
const bigOrNull = (v: unknown) => (v === null || v === undefined ? null : BigInt(String(v)));

// Shape checks for what arrives from a remote. Everything there is untrusted: a teammate's (or anyone's) bad file must be skipped, not thrown.
const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === null || v === undefined || typeof v === "string";
const isGid = (v: unknown) => (typeof v === "string" || typeof v === "number") && /^\d{1,20}$/.test(String(v));
const optGid = (v: unknown) => v === null || v === undefined || v === "" || isGid(v);
const optDate = (v: unknown) => v === null || v === undefined || v === "" || (typeof v === "string" && !Number.isNaN(toDate(v)!.getTime()));
const optStrs = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.every(isStr));
const num = (v: unknown) => v === null || v === undefined || Number.isFinite(Number(v));
const oneOf = (v: unknown, xs: readonly string[]) => typeof v === "string" && xs.includes(v);
const SCOPES = ["REPOSITORY", "OWNER", "PROJECT", "WORKSPACE"] as const;

async function repoByGithubId(db: Db, workspaceId: string, githubId: unknown) {
  if (githubId === null || githubId === undefined) return null;
  return db.repository.findUnique({ where: { workspaceId_githubId: { workspaceId, githubId: BigInt(String(githubId)) } } });
}

// ---------- repositories ----------

const repo: EntityDef = {
  type: "repo",
  order: 1,
  async list(db) {
    const rows = await db.repository.findMany({ where: { spaceId: { not: null }, trackingStatus: { not: "REMOVED" }, isDemo: false }, include: { owner: true } });
    return rows.map((r) => ({
      id: repoEntityId(r.githubId),
      spaceId: r.spaceId,
      data: {
        githubId: r.githubId.toString(), fullName: r.fullName, name: r.name, htmlUrl: r.htmlUrl, description: r.description, visibility: r.visibility,
        isFork: r.isFork, parentGithubId: r.parentGithubId?.toString() ?? null, parentFullName: r.parentFullName, defaultBranch: r.defaultBranch, archived: r.archived,
        owner: { githubId: r.owner.githubId.toString(), login: r.owner.login, type: r.owner.type, avatarUrl: r.owner.avatarUrl },
      },
    }));
  },
  valid(id, data) {
    if (!/^repo-\d{1,20}$/.test(id)) return false;
    if (!data) return true;
    const o = data.owner as Record<string, unknown> | null;
    return (
      isGid(data.githubId) && id === repoEntityId(String(data.githubId)) && isStr(data.fullName) && /^[^/\s]+\/[^/\s]+$/.test(data.fullName) && isStr(data.name) && isStr(data.htmlUrl) &&
      optStr(data.description) && oneOf(data.visibility, ["PUBLIC", "PRIVATE", "INTERNAL", "UNKNOWN"]) && optGid(data.parentGithubId) && optStr(data.parentFullName) && optStr(data.defaultBranch) &&
      !!o && typeof o === "object" && isGid(o.githubId) && isStr(o.login) && oneOf(o.type, ["USER", "ORGANIZATION", "UNKNOWN"]) && optStr(o.avatarUrl)
    );
  },
  /**
   * A remote entity only ever touches a repository that is in THIS space, or that is not here at all yet. A repository this person keeps
   * local-only (or placed in another space) is never re-spaced, renamed or shared by a teammate's file: that would let them point this
   * person's local automation (the upstream auto-updater, say) at another repository. The one exception is a row this space shared before
   * and then removed (its spaceId was cleared by the removal), which a re-share brings back.
   * Inside the space, name and owner follow the shared file: renames are legitimate, and refusing them would make two devices push their
   * own spelling back and forth. Local automation does not trust them: the auto-updater pins the names it was enabled with.
   */
  async apply(db, ctx, id, data) {
    if (!data) {
      const gid = BigInt(id.replace(/^repo-/, ""));
      const r = await repoByGithubId(db, ctx.workspaceId, gid);
      if (r && r.spaceId === ctx.space.id) {
        await db.repository.update({ where: { id: r.id }, data: { trackingStatus: "REMOVED", spaceId: null } });
        await db.repositoryGrant.updateMany({ where: { repositoryId: r.id, revokedAt: null }, data: { revokedAt: new Date() } });
        refreshHubWatch();
      }
      return;
    }
    const githubId = BigInt(String(data.githubId));
    const existing = await repoByGithubId(db, ctx.workspaceId, githubId);
    if (existing && existing.spaceId !== ctx.space.id) {
      if (existing.spaceId !== null) return APPLY_INVALID;
      const sharedHereBefore = await db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId: ctx.space.id, type: "repo", entityId: id } }, select: { spaceId: true } });
      if (!sharedHereBefore || existing.trackingStatus !== "REMOVED") return APPLY_INVALID;
    }
    const o = data.owner as { githubId: string; login: string; type: "USER" | "ORGANIZATION" | "UNKNOWN"; avatarUrl: string | null };
    const owner = await db.githubOwner.upsert({ where: { githubId: BigInt(o.githubId) }, create: { githubId: BigInt(o.githubId), login: o.login, type: o.type, avatarUrl: o.avatarUrl }, update: { login: o.login, type: o.type, avatarUrl: o.avatarUrl } });
    const f = {
      ownerId: owner.id, name: String(data.name), fullName: String(data.fullName), htmlUrl: String(data.htmlUrl), description: (data.description as string | null) ?? null,
      visibility: data.visibility as "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN", isFork: !!data.isFork, parentGithubId: bigOrNull(data.parentGithubId), parentFullName: (data.parentFullName as string | null) ?? null,
      defaultBranch: (data.defaultBranch as string | null) ?? null, archived: !!data.archived, spaceId: ctx.space.id, trackingStatus: "ACTIVE" as const,
    };
    const r = await db.repository.upsert({ where: { workspaceId_githubId: { workspaceId: ctx.workspaceId, githubId } }, create: { workspaceId: ctx.workspaceId, githubId, ...f }, update: f });
    // Application-level visibility mirrors the space audience: this person may see what the space shares.
    await db.repositoryGrant.upsert({
      where: { memberId_repositoryId: { memberId: ctx.localMemberId, repositoryId: r.id } },
      create: { memberId: ctx.localMemberId, repositoryId: r.id, grantedById: ctx.localMemberId, canManageWork: ctx.space.canWrite, canReview: ctx.space.canWrite },
      update: { revokedAt: null, canManageWork: ctx.space.canWrite, canReview: ctx.space.canWrite },
    });
    refreshHubWatch();
  },
};

// ---------- projects ----------

const project: EntityDef = {
  type: "project",
  order: 2,
  setKeys: ["repoIds"],
  async list(db) {
    const rows = await db.project.findMany({ where: { spaceId: { not: null } }, include: { repositories: { include: { repository: true } } } });
    return rows.map((p) => ({
      id: p.id, spaceId: p.spaceId,
      data: { name: p.name, slug: p.slug, description: p.description, automation: p.automation, repoIds: p.repositories.map((x) => repoEntityId(x.repository.githubId)).sort() },
    }));
  },
  valid: (_id, d) => !d || (isStr(d.name) && isStr(d.slug) && optStr(d.description) && optStrs(d.repoIds)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.project.deleteMany({ where: { id } });
      return;
    }
    const f = { name: String(data.name), slug: String(data.slug), description: (data.description as string | null) ?? null, automation: data.automation === "suggest" ? "suggest" : "off", spaceId: ctx.space.id };
    await db.project.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
    await createColumnsForProject(db, id);
    await db.projectMember.upsert({ where: { projectId_memberId: { projectId: id, memberId: ctx.localMemberId } }, create: { projectId: id, memberId: ctx.localMemberId }, update: {} });
    const wanted: string[] = [];
    for (const rid of (data.repoIds as string[]) ?? []) {
      const r = await repoByGithubId(db, ctx.workspaceId, rid.replace(/^repo-/, ""));
      if (r) wanted.push(r.id);
    }
    await db.projectRepository.deleteMany({ where: { projectId: id, repositoryId: { notIn: wanted } } });
    for (const repositoryId of wanted) await db.projectRepository.upsert({ where: { projectId_repositoryId: { projectId: id, repositoryId } }, create: { projectId: id, repositoryId }, update: {} });
  },
};

// ---------- milestones ----------

const milestone: EntityDef = {
  type: "milestone",
  order: 3,
  setKeys: ["repoLinks"],
  async list(db, { commonSpaceId }) {
    const rows = await db.dashboardMilestone.findMany({ include: { project: true, repoLinks: { include: { repository: true } } } });
    return rows.map((m) => ({
      id: m.id,
      spaceId: m.project ? m.project.spaceId : commonSpaceId,
      data: {
        name: m.name, description: m.description, projectId: m.projectId, startDate: day(m.startDate), targetDate: day(m.targetDate), status: m.status, releaseTag: m.releaseTag, releaseUrl: m.releaseUrl, shippedAt: iso(m.shippedAt),
        repoLinks: m.repoLinks.map((l) => `${l.repository.githubId}#${l.githubMilestoneNumber}`).sort(),
      },
    }));
  },
  valid: (_id, d) =>
    !d ||
    (isStr(d.name) && optStr(d.description) && optStr(d.projectId) && optDate(d.startDate) && optDate(d.targetDate) && optStr(d.status) && optStr(d.releaseTag) && optStr(d.releaseUrl) && optDate(d.shippedAt) &&
      optStrs(d.repoLinks) && ((d.repoLinks as string[] | null) ?? []).every((l) => /^\d{1,20}#\d{1,9}$/.test(l))),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.dashboardMilestone.deleteMany({ where: { id } });
      return;
    }
    const projectId = (data.projectId as string | null) ?? null;
    const p = projectId ? await db.project.findUnique({ where: { id: projectId } }) : null;
    const f = { name: String(data.name), description: (data.description as string | null) ?? null, projectId: p ? projectId : null, startDate: toDate(data.startDate), targetDate: toDate(data.targetDate), status: String(data.status ?? "OPEN"), releaseTag: (data.releaseTag as string | null) ?? null, releaseUrl: (data.releaseUrl as string | null) ?? null, shippedAt: toDate(data.shippedAt) };
    await db.dashboardMilestone.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
    const wanted: string[] = [];
    for (const link of (data.repoLinks as string[]) ?? []) {
      const [gid, num] = link.split("#");
      const r = await repoByGithubId(db, ctx.workspaceId, gid);
      if (!r) continue;
      wanted.push(r.id);
      await db.milestoneRepoLink.upsert({ where: { milestoneId_repositoryId: { milestoneId: id, repositoryId: r.id } }, create: { milestoneId: id, repositoryId: r.id, githubMilestoneNumber: Number(num) }, update: { githubMilestoneNumber: Number(num) } });
    }
    await db.milestoneRepoLink.deleteMany({ where: { milestoneId: id, repositoryId: { notIn: wanted } } });
  },
};

// ---------- cards (planning items) ----------

const card: EntityDef = {
  type: "card",
  order: 4,
  setKeys: ["blockedBy", "related", "duplicates"],
  async list(db) {
    const rows = await db.planningItem.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true, column: true, workItem: { include: { repository: true } }, blockedBy: true } });
    return rows.map((c) => ({
      id: c.id, spaceId: c.project.spaceId,
      data: {
        projectId: c.projectId, columnKey: c.column.key, position: c.position, title: c.title, description: c.description,
        workRepoGithubId: c.workItem ? c.workItem.repository.githubId.toString() : (c.workRepoGithubId?.toString() ?? null),
        workNumber: c.workItem ? c.workItem.number : c.workNumber,
        assigneeLogin: c.assigneeLogin, assignedByLogin: c.assignedByLogin, authorLogin: c.authorLogin, labels: c.labels, priority: c.priority, due: day(c.dueDate), milestoneId: c.milestoneId,
        blockedBy: c.blockedBy.filter((l) => l.kind === "blocks").map((l) => l.fromId).sort(),
        related: c.blockedBy.filter((l) => l.kind === "related").map((l) => l.fromId).sort(),
        duplicates: c.blockedBy.filter((l) => l.kind === "duplicates").map((l) => l.fromId).sort(),
        epicId: c.epicId, iterationId: c.iterationId, branchRef: c.branchRef,
      },
    }));
  },
  valid: (_id, d) =>
    !d ||
    (isStr(d.projectId) && isStr(d.columnKey) && isStr(d.title) && num(d.position) && optStr(d.description) && optGid(d.workRepoGithubId) && num(d.workNumber) && optStr(d.assigneeLogin) && optStr(d.assignedByLogin) &&
      optStr(d.authorLogin) && num(d.priority) && optDate(d.due) && optStr(d.milestoneId) && optStr(d.epicId) && optStr(d.iterationId) && optStr(d.branchRef) && optStrs(d.blockedBy) && optStrs(d.related) && optStrs(d.duplicates)),
  async apply(db, ctx, id, data, version) {
    if (!data) {
      await db.planningItem.deleteMany({ where: { id } });
      return;
    }
    const projectId = String(data.projectId);
    const col = await db.planningColumn.findFirst({ where: { projectId, key: String(data.columnKey) } });
    if (!col) return false; // the project entity has not been applied yet; the next pull retries
    const work = data.workRepoGithubId !== null && data.workRepoGithubId !== undefined ? await repoByGithubId(db, ctx.workspaceId, data.workRepoGithubId) : null;
    const wi = work && data.workNumber ? await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: work.id, number: Number(data.workNumber) } } }) : null;
    const ms = data.milestoneId ? await db.dashboardMilestone.findUnique({ where: { id: String(data.milestoneId) } }) : null;
    const epic = data.epicId ? await db.epic.findUnique({ where: { id: String(data.epicId) }, select: { id: true } }) : null;
    const iteration = data.iterationId ? await db.iteration.findUnique({ where: { id: String(data.iterationId) }, select: { id: true } }) : null;
    const f = {
      projectId, columnId: col.id, position: Number(data.position), title: String(data.title), description: (data.description as string | null) ?? null,
      workItemId: wi?.id ?? null, workRepoGithubId: bigOrNull(data.workRepoGithubId), workNumber: data.workNumber === null || data.workNumber === undefined ? null : Number(data.workNumber),
      assigneeLogin: ((data.assigneeLogin as string | null) ?? null)?.toLowerCase() ?? null, assignedByLogin: ((data.assignedByLogin as string | null) ?? null)?.toLowerCase() ?? null, authorLogin: (data.authorLogin as string | null) ?? null,
      labels: (data.labels ?? []) as Prisma.InputJsonValue, priority: Number(data.priority ?? 0), dueDate: toDate(data.due), milestoneId: ms ? ms.id : null, epicId: epic?.id ?? null, iterationId: iteration?.id ?? null, branchRef: (data.branchRef as string | null) ?? null, version,
    };
    await db.planningItem.upsert({ where: { id }, create: { id, createdById: ctx.localMemberId, ...f }, update: f });
  },
  async post(db, _ctx, applied) {
    for (const a of applied) {
      // One pass per link kind, so a "related" link is never mistaken for a blocker (or the reverse).
      for (const [kind, field] of [["blocks", "blockedBy"], ["related", "related"], ["duplicates", "duplicates"]] as const) {
        const want = ((a.data[field] as string[]) ?? []).filter((x) => x !== a.id);
        const existing = await db.planningItem.findMany({ where: { id: { in: want } }, select: { id: true } });
        const ok = existing.map((e) => e.id);
        await db.planningLink.deleteMany({ where: { toId: a.id, kind, fromId: { notIn: ok } } });
        for (const fromId of ok) await db.planningLink.upsert({ where: { fromId_toId: { fromId, toId: a.id } }, create: { fromId, toId: a.id, kind }, update: { kind } });
      }
    }
  },
};

// ---------- task comments (one file per comment, so two people never edit the same file) ----------

const taskcomment: EntityDef = {
  type: "taskcomment",
  order: 5,
  async list(db) {
    const rows = await db.taskComment.findMany({ where: { item: { project: { spaceId: { not: null } } } }, include: { item: { include: { project: true } } } });
    return rows.map((c) => ({ id: c.id, spaceId: c.item.project.spaceId, data: { itemId: c.itemId, authorLogin: c.authorLogin, kind: c.kind, body: c.body, createdAt: iso(c.createdAt), editedAt: iso(c.editedAt) } }));
  },
  valid: (_id, d) => !d || (isStr(d.itemId) && isStr(d.authorLogin) && isStr(d.body) && optStr(d.kind) && optDate(d.createdAt) && optDate(d.editedAt)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.taskComment.deleteMany({ where: { id } });
      return;
    }
    const item = await db.planningItem.findUnique({ where: { id: String(data.itemId) }, select: { id: true } });
    if (!item) return false; // the card has not been applied yet; the next pull retries
    const f = { itemId: item.id, authorLogin: String(data.authorLogin), kind: String(data.kind ?? "COMMENT"), body: String(data.body), createdAt: toDate(data.createdAt) ?? new Date(), editedAt: toDate(data.editedAt) };
    await db.taskComment.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- task checklist items (one file per item) ----------

const checkitem: EntityDef = {
  type: "checkitem",
  order: 5,
  async list(db) {
    const rows = await db.taskCheckItem.findMany({ where: { item: { project: { spaceId: { not: null } } } }, include: { item: { include: { project: true } } } });
    return rows.map((c) => ({ id: c.id, spaceId: c.item.project.spaceId, data: { itemId: c.itemId, text: c.text, done: c.done, position: c.position, doneByLogin: c.doneByLogin, doneAt: iso(c.doneAt), createdAt: iso(c.createdAt) } }));
  },
  valid: (_id, d) => !d || (isStr(d.itemId) && isStr(d.text) && num(d.position) && optStr(d.doneByLogin) && optDate(d.doneAt) && optDate(d.createdAt)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.taskCheckItem.deleteMany({ where: { id } });
      return;
    }
    const item = await db.planningItem.findUnique({ where: { id: String(data.itemId) }, select: { id: true } });
    if (!item) return false; // the card has not been applied yet; the next pull retries
    const f = { itemId: item.id, text: String(data.text), done: !!data.done, position: Number(data.position ?? 0), doneByLogin: (data.doneByLogin as string | null) ?? null, doneAt: toDate(data.doneAt), createdAt: toDate(data.createdAt) ?? new Date() };
    await db.taskCheckItem.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- review routing ----------

const rule: EntityDef = {
  type: "rule",
  order: 5,
  async list(db, { commonSpaceId }) {
    const rows = await db.reviewRule.findMany({ include: { repository: true, project: true } });
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.scope === "REPOSITORY" ? (r.repository?.spaceId ?? null) : r.scope === "PROJECT" ? (r.project?.spaceId ?? null) : commonSpaceId,
      data: { scope: r.scope, repoGithubId: r.repository?.githubId.toString() ?? null, projectId: r.projectId, ownerLogin: r.ownerLogin, labels: r.labels, reviewers: r.reviewers, semantics: r.semantics, reason: r.reason, enabled: r.enabled },
    }));
  },
  valid: (_id, d) => !d || (oneOf(d.scope, SCOPES) && optGid(d.repoGithubId) && optStr(d.projectId) && optStr(d.ownerLogin) && oneOf(d.semantics, ["ANY", "ALL"]) && isStr(d.reason)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.reviewRule.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.repoGithubId);
    const f = {
      scope: data.scope as "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE", repositoryId: r?.id ?? null, projectId: (data.projectId as string | null) ?? null, ownerLogin: (data.ownerLogin as string | null) ?? null,
      labels: (data.labels ?? []) as Prisma.InputJsonValue, reviewers: (data.reviewers ?? []) as Prisma.InputJsonValue, semantics: data.semantics as "ANY" | "ALL", reason: String(data.reason), enabled: !!data.enabled,
    };
    await db.reviewRule.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

// ---------- waiting rules ("this work waits on these people until merged") ----------

const waitrule: EntityDef = {
  type: "waitrule",
  order: 5,
  async list(db, { commonSpaceId }) {
    const rows = await db.waitingRule.findMany({ include: { repository: true, project: true } });
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.scope === "REPOSITORY" ? (r.repository?.spaceId ?? null) : r.scope === "PROJECT" ? (r.project?.spaceId ?? null) : commonSpaceId,
      data: { scope: r.scope, repoGithubId: r.repository?.githubId.toString() ?? null, projectId: r.projectId, ownerLogin: r.ownerLogin, itemType: r.itemType, labels: r.labels, authors: r.authors, includeDrafts: r.includeDrafts, waitingOn: r.waitingOn, reason: r.reason, stage: r.stage, enabled: r.enabled },
    }));
  },
  valid: (_id, d) => !d || (oneOf(d.scope, SCOPES) && optGid(d.repoGithubId) && optStr(d.projectId) && optStr(d.ownerLogin) && optStr(d.itemType) && isStr(d.reason) && optStr(d.stage)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.waitingRule.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.repoGithubId);
    const f = {
      scope: data.scope as "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE", repositoryId: r?.id ?? null, projectId: (data.projectId as string | null) ?? null, ownerLogin: (data.ownerLogin as string | null) ?? null,
      itemType: String(data.itemType ?? "PULL_REQUEST"), labels: (data.labels ?? []) as Prisma.InputJsonValue, authors: (data.authors ?? []) as Prisma.InputJsonValue, includeDrafts: !!data.includeDrafts,
      waitingOn: (data.waitingOn ?? []) as Prisma.InputJsonValue, reason: String(data.reason), stage: String(data.stage ?? ""), enabled: !!data.enabled,
    };
    await db.waitingRule.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

// ---------- shared views (definitions only) ----------

const view: EntityDef = {
  type: "view",
  order: 9,
  async list(db, { commonSpaceId }) {
    // Received copies are listed too, unchanged, so they round-trip: leaving them out would make this computer look like it deleted them.
    // The service refuses to edit a view that belongs to someone else, so a received copy never produces a new version.
    const me = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
    if (!me) return [];
    const rows = await db.savedFilter.findMany({ where: { shared: true, userId: me.id } });
    return rows.map((r) => ({ id: r.id, spaceId: commonSpaceId, data: { scope: r.scope, name: r.name, query: r.query, ownerLogin: r.ownerLogin ?? me.login } }));
  },
  valid: (_id, d) => !d || (isStr(d.scope) && isStr(d.name) && optStr(d.query) && optStr(d.ownerLogin)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.savedFilter.deleteMany({ where: { id, shared: true } });
      return;
    }
    const member = await db.member.findUnique({ where: { id: ctx.localMemberId } });
    if (!member) return false;
    const f = { userId: member.userId, scope: String(data.scope), name: String(data.name), query: String(data.query ?? ""), shared: true, ownerLogin: String(data.ownerLogin ?? "") || null };
    await db.savedFilter.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- boards, epics, iterations and planning history ----------

const projectSpace = async (db: Db, projectId: string) => (await db.project.findUnique({ where: { id: projectId }, select: { spaceId: true } }))?.spaceId ?? null;

const board: EntityDef = {
  type: "board",
  order: 4,
  async list(db) {
    const rows = await db.planBoard.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true } });
    return rows.map((b) => ({ id: b.id, spaceId: b.project.spaceId, data: { projectId: b.projectId, name: b.name, template: b.template, columns: b.columns, groupBy: b.groupBy, density: b.density, position: b.position } }));
  },
  valid: (_id, d) => !d || (isStr(d.projectId) && isStr(d.name) && optStr(d.template) && optStr(d.groupBy) && optStr(d.density) && num(d.position)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.planBoard.deleteMany({ where: { id } });
      return;
    }
    if (!(await db.project.findUnique({ where: { id: String(data.projectId) }, select: { id: true } }))) return false;
    const f = { projectId: String(data.projectId), name: String(data.name), template: String(data.template ?? ""), columns: (data.columns ?? []) as Prisma.InputJsonValue, groupBy: String(data.groupBy ?? "none"), density: String(data.density ?? "comfortable"), position: Number(data.position ?? 0) };
    await db.planBoard.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

const epic: EntityDef = {
  type: "epic",
  order: 3,
  async list(db) {
    const rows = await db.epic.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true } });
    return rows.map((e) => ({ id: e.id, spaceId: e.project.spaceId, data: { projectId: e.projectId, title: e.title, description: e.description, ownerLogin: e.ownerLogin, start: day(e.startDate), target: day(e.targetDate), status: e.status, decisions: e.decisions } }));
  },
  valid: (_id, d) => !d || (isStr(d.projectId) && isStr(d.title) && optStr(d.description) && optStr(d.ownerLogin) && optDate(d.start) && optDate(d.target) && optStr(d.status) && optStr(d.decisions)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.epic.deleteMany({ where: { id } });
      return;
    }
    if (!(await db.project.findUnique({ where: { id: String(data.projectId) }, select: { id: true } }))) return false;
    const f = { projectId: String(data.projectId), title: String(data.title), description: (data.description as string | null) ?? null, ownerLogin: (data.ownerLogin as string | null) ?? null, startDate: toDate(data.start), targetDate: toDate(data.target), status: String(data.status ?? "OPEN"), decisions: (data.decisions as string | null) ?? null };
    await db.epic.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

const iteration: EntityDef = {
  type: "iteration",
  order: 3,
  async list(db) {
    const rows = await db.iteration.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true } });
    return rows.map((i) => ({ id: i.id, spaceId: i.project.spaceId, data: { projectId: i.projectId, name: i.name, start: day(i.startDate), end: day(i.endDate), closedAt: iso(i.closedAt) } }));
  },
  valid: (_id, d) => !d || (isStr(d.projectId) && isStr(d.name) && optDate(d.start) && optDate(d.end) && optDate(d.closedAt)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.iteration.deleteMany({ where: { id } });
      return;
    }
    if (!(await db.project.findUnique({ where: { id: String(data.projectId) }, select: { id: true } }))) return false;
    const f = { projectId: String(data.projectId), name: String(data.name), startDate: toDate(data.start) ?? new Date(), endDate: toDate(data.end) ?? new Date(), closedAt: toDate(data.closedAt) };
    await db.iteration.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

/** Append-only: an event is created once and never edited, so two people can never conflict on one. Events from teammates are stored as received. */
const planevent: EntityDef = {
  type: "planevent",
  order: 9,
  async list(db) {
    const rows = await db.planEvent.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true } });
    return rows.map((e) => ({ id: e.id, spaceId: e.project.spaceId, data: { projectId: e.projectId, itemId: e.itemId, kind: e.kind, fromKey: e.fromKey, toKey: e.toKey, refId: e.refId, actorLogin: e.actorLogin, at: iso(e.at) } }));
  },
  valid: (_id, d) => !d || (isStr(d.projectId) && isStr(d.itemId) && isStr(d.kind) && optStr(d.fromKey) && optStr(d.toKey) && optStr(d.refId) && optStr(d.actorLogin) && optDate(d.at)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.planEvent.deleteMany({ where: { id } });
      return;
    }
    if (!(await db.project.findUnique({ where: { id: String(data.projectId) }, select: { id: true } }))) return false;
    const f = { projectId: String(data.projectId), itemId: String(data.itemId), kind: String(data.kind), fromKey: (data.fromKey as string | null) ?? null, toKey: (data.toKey as string | null) ?? null, refId: (data.refId as string | null) ?? null, actorLogin: (data.actorLogin as string | null) ?? null, at: toDate(data.at) ?? new Date() };
    await db.planEvent.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};
void projectSpace;

// ---------- label mappings, upstream subscriptions and backport records ----------

const labelmap: EntityDef = {
  type: "labelmap",
  order: 9,
  async list(db, { commonSpaceId }) {
    const rows = await db.labelMap.findMany();
    const repos = new Map((await db.repository.findMany({ where: { id: { in: rows.flatMap((r) => (r.repoKey ? [r.repoKey] : [])) } }, select: { id: true, githubId: true } })).map((r) => [r.id, r.githubId.toString()]));
    return rows.map((m) => ({ id: m.id, spaceId: commonSpaceId, data: { concept: m.concept, spelling: m.spelling, repoGithubId: m.repoKey ? (repos.get(m.repoKey) ?? null) : null } }));
  },
  valid: (_id, d) => !d || (isStr(d.concept) && isStr(d.spelling) && optGid(d.repoGithubId)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.labelMap.deleteMany({ where: { id } });
      return;
    }
    let repoKey = "";
    if (data.repoGithubId) {
      const r = await repoByGithubId(db, ctx.workspaceId, data.repoGithubId);
      if (!r) return false;
      repoKey = r.id;
    }
    const f = { concept: String(data.concept), spelling: String(data.spelling), repoKey };
    await db.labelMap.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

const upstreamsub: EntityDef = {
  type: "upstreamsub",
  order: 9,
  async list(db, { commonSpaceId }) {
    const rows = await db.upstreamSubscription.findMany();
    const maps = new Map((await db.forkMapping.findMany({ where: { id: { in: rows.flatMap((r) => (r.mappingId ? [r.mappingId] : [])) } } })).map((m) => [m.id, m]));
    return rows.map((s) => ({ id: s.id, spaceId: commonSpaceId, data: { name: s.name, mappingId: s.mappingId && maps.has(s.mappingId) ? s.mappingId : null, criteria: s.criteria, muted: s.muted } }));
  },
  valid: (_id, d) => !d || (isStr(d.name) && optStr(d.mappingId)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.upstreamSubscription.deleteMany({ where: { id } });
      return;
    }
    const mappingId = (data.mappingId as string | null) ?? null;
    if (mappingId && !(await db.forkMapping.findUnique({ where: { id: mappingId }, select: { id: true } }))) return false;
    const f = { name: String(data.name), mappingId, criteria: (data.criteria ?? {}) as Prisma.InputJsonValue, muted: !!data.muted };
    await db.upstreamSubscription.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

const backport: EntityDef = {
  type: "backport",
  order: 7,
  async list(db) {
    const rows = await db.backportRecord.findMany({ include: { mapping: { include: { fork: true } } } });
    return rows.map((b) => ({ id: b.id, spaceId: b.mapping.fork.spaceId, data: { mappingId: b.mappingId, upstreamNumber: b.upstreamNumber, targetBranch: b.targetBranch, state: b.state, evidence: b.evidence, localSha: b.localSha, note: b.note, byLogin: b.byLogin } }));
  },
  valid: (_id, d) => !d || (isStr(d.mappingId) && isStr(d.targetBranch) && Number.isInteger(Number(d.upstreamNumber)) && optStr(d.state) && optStr(d.evidence) && optStr(d.localSha) && optStr(d.note) && optStr(d.byLogin)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.backportRecord.deleteMany({ where: { id } });
      return;
    }
    if (!(await db.forkMapping.findUnique({ where: { id: String(data.mappingId) }, select: { id: true } }))) return false;
    const f = { mappingId: String(data.mappingId), upstreamNumber: Number(data.upstreamNumber), targetBranch: String(data.targetBranch), state: String(data.state ?? "planned"), evidence: String(data.evidence ?? "unknown"), localSha: (data.localSha as string | null) ?? null, note: (data.note as string | null) ?? null, byLogin: (data.byLogin as string | null) ?? null };
    await db.backportRecord.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- reviewer availability and configured backups ----------

const availability: EntityDef = {
  type: "availability",
  order: 9,
  async list(db, { commonSpaceId }) {
    // The entity id is derived from the login, not the row id: two devices that set one person's availability write the SAME entity
    // (an ordinary merge) instead of two random ids that each side adopts and then tombstones. Rows made with an old random id are read
    // under the derived id too, so they converge on the next capture.
    const rows = await db.reviewerAvailability.findMany();
    return rows.filter((a) => ENTITY_ID.test(availabilityId(a.login))).map((a) => ({ id: availabilityId(a.login), spaceId: commonSpaceId, data: { login: a.login, from: iso(a.unavailableFrom), until: iso(a.unavailableUntil), backup: a.backupLogin, note: a.note } }));
  },
  valid: (id, d) => !d || (isStr(d.login) && !!d.login && (!id.startsWith("avail-") || id === availabilityId(d.login)) && optDate(d.from) && optDate(d.until) && optStr(d.backup) && optStr(d.note)),
  async apply(db, ctx, id, data) {
    if (!data) {
      // A derived id names the login. An old random id names nothing any more (its row is listed under the derived id): ignoring its
      // tombstone is what keeps the old id's retirement from deleting the person's availability.
      if (!id.startsWith("avail-")) return;
      const rows = await db.reviewerAvailability.findMany({ where: { workspaceId: ctx.workspaceId } });
      const gone = rows.filter((r) => availabilityId(r.login) === id).map((r) => r.id);
      if (gone.length) await db.reviewerAvailability.deleteMany({ where: { id: { in: gone } } });
      return;
    }
    const f = { unavailableFrom: toDate(data.from), unavailableUntil: toDate(data.until), backupLogin: (data.backup as string | null) ?? null, note: (data.note as string | null) ?? null };
    const login = String(data.login);
    // One row per person, whatever its id or the case of the login: the existing row is updated in place, never re-keyed.
    const mine = (await db.reviewerAvailability.findMany({ where: { workspaceId: ctx.workspaceId } })).find((r) => availabilityId(r.login) === availabilityId(login));
    if (mine) await db.reviewerAvailability.update({ where: { id: mine.id }, data: f });
    else await db.reviewerAvailability.create({ data: { id: availabilityId(login), workspaceId: ctx.workspaceId, login, ...f } });
  },
};

// ---------- fork mappings and upstream triage ----------

const forkmap: EntityDef = {
  type: "forkmap",
  order: 6,
  async list(db) {
    const rows = await db.forkMapping.findMany({ where: { fork: { spaceId: { not: null } } }, include: { fork: true, upstream: true } });
    return rows.map((m) => ({ id: m.id, spaceId: m.fork.spaceId, data: { forkRepoGithubId: m.fork.githubId.toString(), upstreamRepoGithubId: m.upstream.githubId.toString(), forkBranch: m.forkBranch, upstreamBranch: m.upstreamBranch } }));
  },
  valid: (_id, d) => !d || (isGid(d.forkRepoGithubId) && isGid(d.upstreamRepoGithubId) && isStr(d.forkBranch) && !!d.forkBranch && isStr(d.upstreamBranch) && !!d.upstreamBranch),
  async apply(db, ctx, id, data) {
    // A mapping whose fork is not in this space (local-only, or another space) is this person's own: a remote file neither changes nor deletes it.
    const current = await db.forkMapping.findUnique({ where: { id }, include: { fork: { select: { spaceId: true } } } });
    if (current && current.fork.spaceId !== ctx.space.id) return APPLY_INVALID;
    if (!data) {
      await db.forkMapping.deleteMany({ where: { id } });
      return;
    }
    const fork = await repoByGithubId(db, ctx.workspaceId, data.forkRepoGithubId);
    const up = await repoByGithubId(db, ctx.workspaceId, data.upstreamRepoGithubId);
    if (fork && fork.spaceId !== ctx.space.id) return APPLY_INVALID;
    if (!fork || !up) return false;
    const f = { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: String(data.forkBranch), upstreamBranch: String(data.upstreamBranch) };
    await db.forkMapping.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

const triage: EntityDef = {
  type: "triage",
  order: 7,
  async list(db) {
    const rows = await db.upstreamIssueTriage.findMany({ where: { mapping: { fork: { spaceId: { not: null } } } }, include: { mapping: { include: { fork: true } } } });
    return rows.map((t) => ({ id: t.id, spaceId: t.mapping.fork.spaceId, data: { mappingId: t.mappingId, issueNumber: t.issueNumber, title: t.title, htmlUrl: t.htmlUrl, status: t.status, note: t.note } }));
  },
  valid: (_id, d) =>
    !d || (isStr(d.mappingId) && Number.isInteger(Number(d.issueNumber)) && isStr(d.title) && isStr(d.htmlUrl) && oneOf(d.status, ["UNTRIAGED", "WATCHING", "RELEVANT", "ADDRESSED", "IGNORED"]) && optStr(d.note)),
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.upstreamIssueTriage.deleteMany({ where: { id } });
      return;
    }
    const m = await db.forkMapping.findUnique({ where: { id: String(data.mappingId) } });
    if (!m) return false;
    const f = { mappingId: m.id, issueNumber: Number(data.issueNumber), title: String(data.title), htmlUrl: String(data.htmlUrl), status: data.status as "UNTRIAGED" | "WATCHING" | "RELEVANT" | "ADDRESSED" | "IGNORED", note: (data.note as string | null) ?? null };
    await db.upstreamIssueTriage.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- manual waiting annotations ----------

const waiting: EntityDef = {
  type: "waiting",
  order: 8,
  async list(db) {
    const rows = await db.waitingRecord.findMany({ where: { source: "MANUAL" }, include: { workItem: { include: { repository: true } }, planningItem: { include: { project: true } } } });
    const out: Listed[] = [];
    for (const w of rows) {
      const spaceId = w.workItem?.repository.spaceId ?? w.planningItem?.project.spaceId ?? null;
      out.push({
        id: w.id, spaceId,
        data: {
          workRepoGithubId: w.workItem?.repository.githubId.toString() ?? null, workNumber: w.workItem?.number ?? null, cardId: w.planningItemId,
          reviewerKind: w.reviewerKind, reviewerRef: w.reviewerRef, reason: w.reason, stage: w.stage, status: w.status, startedAt: iso(w.startedAt), clearedAt: iso(w.clearedAt), clearReason: w.clearReason,
        },
      });
    }
    return out;
  },
  valid: (_id, d) =>
    !d ||
    (optGid(d.workRepoGithubId) && num(d.workNumber) && optStr(d.cardId) && oneOf(d.reviewerKind, ["USER", "TEAM", "EXTERNAL_ROLE"]) && isStr(d.reviewerRef) && isStr(d.reason) && optStr(d.stage) &&
      oneOf(d.status, ["PENDING", "SATISFIED", "CANCELLED", "STALE"]) && isStr(d.startedAt) && optDate(d.startedAt) && optDate(d.clearedAt) && optStr(d.clearReason)),
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.waitingRecord.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.workRepoGithubId);
    const wi = r && data.workNumber ? await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: r.id, number: Number(data.workNumber) } } }) : null;
    const card = data.cardId ? await db.planningItem.findUnique({ where: { id: String(data.cardId) } }) : null;
    if (!wi && !card) return false;
    const f = {
      workspaceId: ctx.workspaceId, workItemId: wi?.id ?? null, planningItemId: card?.id ?? null, source: "MANUAL" as const, reviewerKind: data.reviewerKind as "USER" | "TEAM" | "EXTERNAL_ROLE",
      reviewerRef: String(data.reviewerRef), reason: String(data.reason), stage: String(data.stage ?? ""), status: data.status as "PENDING" | "SATISFIED" | "CANCELLED" | "STALE", startedAt: new Date(String(data.startedAt)),
      clearedAt: toDate(data.clearedAt), clearReason: (data.clearReason as string | null) ?? null,
    };
    await db.waitingRecord.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

/** Every apply checks the id and the shape first, so a malformed remote entity answers APPLY_INVALID instead of throwing mid-pull. */
const guarded = (d: EntityDef): EntityDef => ({
  ...d,
  async apply(db, ctx, id, data, version) {
    if (typeof id !== "string" || !ENTITY_ID.test(id)) return APPLY_INVALID;
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) return APPLY_INVALID;
    if (d.valid && !d.valid(id, data)) return APPLY_INVALID;
    return d.apply(db, ctx, id, data, version);
  },
});

export const ENTITY_TYPES: EntityDef[] = [repo, project, milestone, epic, iteration, card, board, planevent, taskcomment, checkitem, rule, waitrule, forkmap, triage, waiting, view, availability, labelmap, upstreamsub, backport].map(guarded);
export const entityDef = (type: string) => ENTITY_TYPES.find((t) => t.type === type);
export const entityPath = (type: string, id: string) => `entities/${type}/${id}.json`;
export const parseEntityPath = (path: string): { type: string; id: string } | null => {
  const m = /^entities\/([a-z]+)\/([A-Za-z0-9_-]{1,128})\.json$/.exec(path);
  return m ? { type: m[1], id: m[2] } : null;
};
