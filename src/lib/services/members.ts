import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, isAdminRole, isAssignableRole, type Role } from "@/lib/authz/roles";
import type { Viewer } from "@/lib/authz/viewer";
import { purgeAccessAfterMembershipEnd } from "@/lib/github/access-cache";
import { audit } from "./audit";
import { purgeDigests } from "./digest-purge";

/**
 * Member administration: roles, removal, reinstatement, leaving, ownership transfer. docs/roles.md has the rules.
 * Every write re-reads the ACTOR inside its transaction, so a viewer loaded a moment ago and demoted or removed since cannot act on
 * stale state, and every target is looked up by (id, workspaceId) so another workspace's member id is simply not found.
 */
type Tx = Prisma.TransactionClient;
type Actor = Pick<Viewer, "workspaceId" | "memberId" | "userId">;

export type MemberRow = { id: string; userId: string; login: string; name: string | null; email: string | null; role: Role; status: "ACTIVE" | "REVOKED"; createdAt: Date; revokedAt: Date | null; isSelf: boolean };

/**
 * The acting member, freshly read: still ACTIVE, with the role they have NOW. Every member-administration transaction starts here, and
 * the first statement locks the workspace's member rows (FOR UPDATE), so these transactions run one after another per workspace:
 * under READ COMMITTED a concurrent transfer and removal/demotion could otherwise each act on a stale read and leave no OWNER.
 * Rows read after the lock are the committed ones.
 */
async function freshActor(tx: Tx, v: Actor) {
  await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "workspaceId" = ${v.workspaceId} FOR UPDATE`;
  const m = await tx.member.findFirst({ where: { id: v.memberId, workspaceId: v.workspaceId, status: "ACTIVE" } });
  if (!m) throw new ForbiddenError("You are no longer a member of this workspace");
  return m;
}

async function targetOf(tx: Tx, workspaceId: string, memberId: unknown) {
  if (typeof memberId !== "string" || !memberId) throw new NotFoundError();
  const t = await tx.member.findFirst({ where: { id: memberId, workspaceId } });
  if (!t) throw new NotFoundError();
  return t;
}

async function assertAdminRemains(tx: Tx, workspaceId: string, exceptMemberId: string) {
  const n = await tx.member.count({ where: { workspaceId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] }, id: { not: exceptMemberId } } });
  if (n < 1) throw new ConflictError("A workspace needs at least one administrator.");
}

/** A person who can no longer invite (removed, left, or demoted below ADMIN) leaves no live invitations behind. */
async function revokePendingInvitations(tx: Tx, workspaceId: string, memberId: string, now: Date) {
  await tx.invitation.updateMany({ where: { workspaceId, invitedByMemberId: memberId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * Federation access (docs/federation.md) never outlives the consent it was given under. Grants this person approved as a provider are
 * revoked; with `links` (a removal) their links to other instances are ended too (token deleted, cache cleared). A reinstated or
 * demoted person must approve again, at the role they have now.
 */
async function endFederationAccess(tx: Tx, workspaceId: string, userId: string, now: Date, links: boolean) {
  await tx.federationGrant.updateMany({ where: { workspaceId, userId, revokedAt: null }, data: { revokedAt: now } });
  if (!links) return;
  await tx.federationLink.updateMany({ where: { workspaceId, userId, status: { in: ["ACTIVE", "PENDING"] } }, data: { status: "REVOKED", tokenEnc: null, verifierEnc: null, stateHash: null, revokedAt: now } });
  await tx.federationCache.deleteMany({ where: { workspaceId, userId } });
}

const ROLE_RANK: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2, READER: 3 };
const lowered = (from: string, to: string) => (ROLE_RANK[to] ?? 9) > (ROLE_RANK[from] ?? 9);

/**
 * Ends a membership: REVOKED (not deleted, so authorship and the audit trail keep pointing at someone), their project, space and
 * repository grants dropped, and every login of theirs that was bound to this workspace unbound. loadViewer and
 * resolveActiveWorkspaceId already require an ACTIVE row on every request, so access ends on the next call whatever a cookie says.
 */
async function endMembership(tx: Tx, workspaceId: string, member: { id: string; userId: string }, now: Date) {
  await tx.member.update({ where: { id: member.id, workspaceId }, data: { status: "REVOKED", revokedAt: now } });
  await revokePendingInvitations(tx, workspaceId, member.id, now);
  await tx.projectMember.deleteMany({ where: { memberId: member.id } });
  await tx.accessSpaceMember.deleteMany({ where: { memberId: member.id } });
  await tx.repositoryGrant.updateMany({ where: { memberId: member.id, revokedAt: null }, data: { revokedAt: now } });
  await purgeDigests(tx, workspaceId, [member.userId]); // a stored digest must not outlive the access it was made from
  await purgeAccessAfterMembershipEnd(tx, member.userId, workspaceId); // nor the cached GitHub access that came through this workspace's installations
  await tx.session.updateMany({ where: { userId: member.userId, activeWorkspaceId: workspaceId }, data: { activeWorkspaceId: null } });
  await endFederationAccess(tx, workspaceId, member.userId, now, true);
}

/** Everyone in the workspace, active first. Administrators only: the list carries email addresses. */
export async function listMembers(db: Db, v: Viewer): Promise<MemberRow[]> {
  if (!can(v, "manageMembers")) throw new ForbiddenError("Administrator only");
  const rows = await db.member.findMany({ where: { workspaceId: v.workspaceId }, include: { user: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const rank: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2, READER: 3 };
  return rows
    .map((m) => ({ id: m.id, userId: m.userId, login: m.user.login, name: m.user.name, email: m.user.email, role: m.role as Role, status: m.status, createdAt: m.createdAt, revokedAt: m.revokedAt, isSelf: m.id === v.memberId }))
    .sort((a, b) => Number(a.status === "REVOKED") - Number(b.status === "REVOKED") || rank[a.role] - rank[b.role]);
}

export async function changeRole(db: Db, v: Viewer, memberId: unknown, newRole: unknown): Promise<void> {
  if (!isAssignableRole(newRole)) throw new ValidationError("Choose Admin, Member or Reader. Ownership moves only by transfer.");
  await db.$transaction(async (tx) => {
    const actor = await freshActor(tx, v);
    const t = await targetOf(tx, v.workspaceId, memberId);
    if (t.role === "OWNER") throw new ForbiddenError("The owner's role changes only by transferring ownership.");
    if (!can(actor, "changeRoles", { targetRole: t.role, newRole })) throw new ForbiddenError("You cannot change that role");
    if (t.status !== "ACTIVE") throw new ConflictError("This person was removed. Reinstate them first.");
    if (t.role === newRole) return;
    if (isAdminRole(t.role) && !isAdminRole(newRole)) await assertAdminRemains(tx, v.workspaceId, t.id);
    await tx.member.update({ where: { id: t.id, workspaceId: v.workspaceId }, data: { role: newRole } });
    if (!isAdminRole(newRole)) await revokePendingInvitations(tx, v.workspaceId, t.id, new Date());
    if (lowered(t.role, newRole)) await endFederationAccess(tx, v.workspaceId, t.userId, new Date(), false); // a grant approved at a higher role must not outlive it
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "member.role", { type: "Member", id: t.id }, { from: t.role, to: newRole });
  });
}

export async function removeMember(db: Db, v: Viewer, memberId: unknown, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    const actor = await freshActor(tx, v);
    const t = await targetOf(tx, v.workspaceId, memberId);
    if (t.id === actor.id) throw new ValidationError("Use Leave workspace to remove yourself.");
    if (t.role === "OWNER") throw new ForbiddenError("The owner cannot be removed. Transfer ownership first.");
    if (!can(actor, "manageMembers", { targetRole: t.role })) throw new ForbiddenError("You cannot remove that person");
    if (t.status !== "ACTIVE") throw new ConflictError("This person is already removed.");
    if (isAdminRole(t.role)) await assertAdminRemains(tx, v.workspaceId, t.id);
    await endMembership(tx, v.workspaceId, t, now);
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "member.removed", { type: "Member", id: t.id }, { role: t.role });
  });
}

/** Gives a removed person their seat back with the role chosen now. Space and project memberships were dropped at removal and are granted again on purpose. */
export async function reinstateMember(db: Db, v: Viewer, memberId: unknown, role: unknown = "MEMBER"): Promise<void> {
  if (!isAssignableRole(role)) throw new ValidationError("Choose Admin, Member or Reader.");
  await db.$transaction(async (tx) => {
    const actor = await freshActor(tx, v);
    const t = await targetOf(tx, v.workspaceId, memberId);
    if (!can(actor, "manageMembers", { targetRole: role, newRole: role })) throw new ForbiddenError("You cannot do that");
    if (t.status !== "REVOKED") throw new ConflictError("This person is not removed.");
    await tx.member.update({ where: { id: t.id, workspaceId: v.workspaceId }, data: { status: "ACTIVE", revokedAt: null, role } });
    await endFederationAccess(tx, v.workspaceId, t.userId, new Date(), false); // belt: removals made before grants were revoked at removal
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "member.reinstated", { type: "Member", id: t.id }, { role });
  });
}

/** A member leaves. The owner cannot: the workspace would have none. Their data stays; their access ends exactly like a removal. */
export async function leaveWorkspace(db: Db, v: Viewer, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    const actor = await freshActor(tx, v);
    if (actor.role === "OWNER") throw new ConflictError("The owner cannot leave. Transfer ownership to an admin first.");
    if (!can(actor, "leaveWorkspace")) throw new ForbiddenError("You cannot leave this workspace");
    await endMembership(tx, v.workspaceId, actor, now);
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "member.left", { type: "Member", id: actor.id });
  });
}

/**
 * Hands ownership to an ACTIVE ADMIN. One transaction, two guarded updates: the current owner becomes ADMIN, then the target becomes
 * OWNER. Each update names the role it expects, so a concurrent transfer (or a target demoted meanwhile) updates nothing and the whole
 * transaction rolls back; the partial unique index Member_one_owner is the last line behind it.
 */
export async function transferOwnership(db: Db, v: Viewer, targetMemberId: unknown): Promise<void> {
  await db.$transaction(async (tx) => {
    const actor = await freshActor(tx, v);
    if (actor.role !== "OWNER") throw new ForbiddenError("Only the owner can transfer ownership");
    const t = await targetOf(tx, v.workspaceId, targetMemberId);
    if (t.id === actor.id) throw new ValidationError("You already own this workspace.");
    if (!can(actor, "transferOwnership", { targetRole: t.role, targetActive: t.status === "ACTIVE" })) throw new ConflictError("Ownership can only go to an active admin. Make them an admin first.");
    const down = await tx.member.updateMany({ where: { id: actor.id, workspaceId: v.workspaceId, role: "OWNER", status: "ACTIVE" }, data: { role: "ADMIN" } });
    if (down.count !== 1) throw new ConflictError("Ownership changed while you were doing this. Reload and try again.");
    const up = await tx.member.updateMany({ where: { id: t.id, workspaceId: v.workspaceId, role: "ADMIN", status: "ACTIVE" }, data: { role: "OWNER" } });
    if (up.count !== 1) throw new ConflictError("That person is no longer an active admin. Nothing was changed.");
    await endFederationAccess(tx, v.workspaceId, actor.userId, new Date(), false); // the previous owner's role dropped
    await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "workspace.ownership", { type: "Member", id: t.id }, { from: actor.id, to: t.id });
  });
}
