import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/auth/accounts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/authz/roles";
import { requireProject, type Viewer } from "@/lib/authz/viewer";
import { audit } from "./audit";

/**
 * Spaces as access-control lists (docs/roles.md). A COMMON space (one per workspace) is read by every active member; a RESTRICTED
 * space only by its AccessSpaceMember rows, and written only where `canWrite` is set AND the person's role is at least MEMBER.
 * A project lives in one space (Project.accessSpaceId, null = COMMON). Visibility is enforced where projects are queried
 * (projectWhere / planningWhere in authz/viewer.ts and services/queries.ts), not here.
 * Not to be confused with `Space`, the GitHub or hub sync space.
 */
type Tx = Db | Prisma.TransactionClient;

export const SPACE_NAME_MAX = 60;

/** The workspace's COMMON space, created if it is missing (new workspaces make it with the workspace; this also repairs old data). */
export async function ensureCommonSpace(tx: Tx, workspaceId: string): Promise<{ id: string }> {
  const found = await tx.accessSpace.findFirst({ where: { workspaceId, kind: "COMMON" }, select: { id: true } });
  if (found) return found;
  try {
    return await tx.accessSpace.create({ data: { workspaceId, kind: "COMMON", name: "Everyone" }, select: { id: true } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return (await tx.accessSpace.findFirstOrThrow({ where: { workspaceId, kind: "COMMON" }, select: { id: true } }));
  }
}

function requireManager(v: Viewer) {
  if (!can(v, "manageSpaces")) throw new ForbiddenError("Administrator only");
}

async function spaceOf(db: Tx, v: Viewer, spaceId: unknown) {
  if (typeof spaceId !== "string" || !spaceId) throw new NotFoundError();
  const s = await db.accessSpace.findFirst({ where: { id: spaceId, workspaceId: v.workspaceId } });
  if (!s) throw new NotFoundError();
  return s;
}

export type SpaceSummary = { id: string; kind: "COMMON" | "RESTRICTED"; name: string; projectCount: number; members: { memberId: string; login: string; email: string | null; role: string; canWrite: boolean }[]; isMember: boolean };

/** Every space of the workspace with its members: the administrator's panel. A restricted space's PROJECTS stay hidden from non-members; only its membership list shows here. */
export async function listSpacesForAdmin(db: Db, v: Viewer): Promise<SpaceSummary[]> {
  requireManager(v);
  await ensureCommonSpace(db, v.workspaceId);
  const rows = await db.accessSpace.findMany({
    where: { workspaceId: v.workspaceId },
    include: { members: { include: { member: { include: { user: true } } } }, _count: { select: { projects: true } } },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });
  // The common space holds every project that names no restricted space.
  const commonCount = await db.project.count({ where: { workspaceId: v.workspaceId, accessSpaceId: null } });
  return rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    projectCount: s.kind === "COMMON" ? commonCount : s._count.projects,
    isMember: s.members.some((m) => m.memberId === v.memberId),
    members: s.members.map((m) => ({ memberId: m.memberId, login: m.member.user.login, email: m.member.user.email, role: m.member.role, canWrite: m.canWrite })).sort((a, b) => a.login.localeCompare(b.login)),
  }));
}

/** Spaces this viewer may put things in or see: COMMON, and restricted ones they belong to. For pickers. */
export async function listMySpaces(db: Db, v: Viewer): Promise<{ id: string; kind: "COMMON" | "RESTRICTED"; name: string; canWrite: boolean }[]> {
  const rows = await db.accessSpace.findMany({ where: { workspaceId: v.workspaceId, OR: [{ kind: "COMMON" }, { members: { some: { memberId: v.memberId } } }] }, include: { members: { where: { memberId: v.memberId } } }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  return rows.map((s) => ({ id: s.id, kind: s.kind, name: s.name, canWrite: can(v, "write", { spaceCanWrite: s.kind === "COMMON" ? undefined : s.members[0]?.canWrite === true }) }));
}

export async function createRestrictedSpace(db: Db, v: Viewer, rawName: unknown): Promise<{ id: string }> {
  requireManager(v);
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ValidationError("Give the space a name.");
  if (name.length > SPACE_NAME_MAX) throw new ValidationError(`Keep the name under ${SPACE_NAME_MAX + 1} characters.`);
  return db.$transaction(async (tx) => {
    const s = await tx.accessSpace.create({ data: { workspaceId: v.workspaceId, kind: "RESTRICTED", name }, select: { id: true } });
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "space.created", { type: "AccessSpace", id: s.id }, { name });
    return s;
  });
}

/** A restricted space with projects in it cannot be deleted: moving them to the common space would show them to everyone, so an administrator moves them on purpose first. */
export async function deleteSpace(db: Db, v: Viewer, spaceId: unknown): Promise<void> {
  requireManager(v);
  await db.$transaction(async (tx) => {
    const s = await spaceOf(tx, v, spaceId);
    if (s.kind === "COMMON") throw new ConflictError("The common space cannot be deleted.");
    if ((await tx.project.count({ where: { workspaceId: v.workspaceId, accessSpaceId: s.id } })) > 0) throw new ConflictError("Move this space's projects elsewhere first.");
    await tx.accessSpace.delete({ where: { id: s.id, workspaceId: v.workspaceId } });
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "space.deleted", { type: "AccessSpace", id: s.id });
  });
}

/** Adds a member to a restricted space, or changes their write flag. Only ACTIVE members of this workspace; the common space's membership is implicit. */
export async function setSpaceMember(db: Db, v: Viewer, spaceId: unknown, memberId: unknown, canWrite: boolean): Promise<void> {
  requireManager(v);
  await db.$transaction(async (tx) => {
    const s = await spaceOf(tx, v, spaceId);
    if (s.kind === "COMMON") throw new ConflictError("Everyone is in the common space already.");
    const m = typeof memberId === "string" ? await tx.member.findFirst({ where: { id: memberId, workspaceId: v.workspaceId, status: "ACTIVE" }, select: { id: true } }) : null;
    if (!m) throw new ValidationError("Choose an active member of this workspace.");
    await tx.accessSpaceMember.upsert({ where: { spaceId_memberId: { spaceId: s.id, memberId: m.id } }, create: { spaceId: s.id, memberId: m.id, canWrite }, update: { canWrite } });
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "space.member", { type: "AccessSpace", id: s.id }, { memberId: m.id, canWrite });
  });
}

export async function removeSpaceMember(db: Db, v: Viewer, spaceId: unknown, memberId: unknown): Promise<void> {
  requireManager(v);
  await db.$transaction(async (tx) => {
    const s = await spaceOf(tx, v, spaceId);
    if (typeof memberId !== "string") throw new NotFoundError();
    await tx.accessSpaceMember.deleteMany({ where: { spaceId: s.id, memberId } });
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "space.member.removed", { type: "AccessSpace", id: s.id }, { memberId });
  });
}

/** Puts a project in a space (null = the common space). The administrator must be able to see the project, and may only target a space of this workspace. */
export async function setProjectAccessSpace(db: Db, v: Viewer, projectId: unknown, spaceId: unknown): Promise<void> {
  requireManager(v);
  if (typeof projectId !== "string") throw new NotFoundError();
  const project = await requireProject(db, v, projectId);
  const target = typeof spaceId === "string" && spaceId ? await spaceOf(db, v, spaceId) : null;
  // Into or out of a restricted space only for someone who is IN it: nobody pulls a hidden project into view, or hides a project from its own people, blind.
  // (Out of: the project is invisible to a non-member, so requireProject above already answered NotFound; the check below is the explicit second line.)
  const restrictedIds = [project.accessSpaceId, target?.kind === "RESTRICTED" ? target.id : null].filter((x): x is string => !!x);
  for (const sid of restrictedIds) {
    const inside = await db.accessSpaceMember.findFirst({ where: { spaceId: sid, memberId: v.memberId, space: { workspaceId: v.workspaceId } }, select: { memberId: true } });
    if (!inside) throw new ForbiddenError("Join the restricted space first: only its members can move projects into or out of it.");
  }
  await db.project.update({ where: { id: project.id, workspaceId: v.workspaceId }, data: { accessSpaceId: target && target.kind === "RESTRICTED" ? target.id : null } });
  await audit(db, { workspaceId: v.workspaceId, userId: v.userId }, "project.space", { type: "Project", id: project.id }, { space: target?.id ?? "common" });
}
