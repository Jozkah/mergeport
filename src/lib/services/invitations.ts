import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, isAssignableRole, type Role } from "@/lib/authz/roles";
import type { Viewer } from "@/lib/authz/viewer";
import { normalizeEmail, isUniqueViolation } from "@/lib/auth/accounts";
import { invitationMail } from "@/lib/auth/mail-templates";
import type { Mailer } from "@/lib/auth/mailer";
import { claimGap, take } from "@/lib/auth/rate-limit";
import { audit } from "./audit";

/**
 * Email invitations (docs/auth.md, docs/roles.md). The email address in the invitation IS the identity proof: accepting needs a
 * signed-in user whose VERIFIED email equals it, which a magic link to that address or an OIDC login with a verified claim gives.
 * Signing up never joins anyone: the person has to open the invitation and press Join.
 */
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
export const INVITE_LIMITS = { perAdminPerHour: 20, perWorkspacePerDay: 100, gapMs: 60_000 } as const;

type Tx = Prisma.TransactionClient;
type Sender = { mailer: Mailer; origin: string; now?: Date };

const linkFor = (origin: string, token: string) => `${origin}/invite/${token}`;

/** Per-admin and per-workspace budgets and a spacing per address, so one admin cannot turn the invite form into a mail cannon. */
async function spend(db: Db, v: Pick<Viewer, "memberId" | "workspaceId">, email: string, now: Date) {
  if (!(await take(db, `inv:admin:${v.memberId}`, INVITE_LIMITS.perAdminPerHour, HOUR, now))) throw new ConflictError("You have sent a lot of invitations. Try again in an hour.");
  if (!(await take(db, `inv:ws:${v.workspaceId}`, INVITE_LIMITS.perWorkspacePerDay, 24 * HOUR, now))) throw new ConflictError("This workspace has sent many invitations today. Try again tomorrow.");
  if (!(await claimGap(db, `inv:gap:${sha256(`${v.workspaceId}|${email}`)}`, INVITE_LIMITS.gapMs, now))) throw new ConflictError("An invitation to that address was just sent. Wait a minute before sending another.");
}

async function actorOf(db: Db | Tx, v: Pick<Viewer, "memberId" | "workspaceId">) {
  const m = await db.member.findFirst({ where: { id: v.memberId, workspaceId: v.workspaceId, status: "ACTIVE" }, include: { user: true } });
  if (!m) throw new ForbiddenError("You are no longer a member of this workspace");
  return m;
}

/** The member row of this workspace behind an address, if any (a user holding it, or an identity that carries it). */
async function memberForEmail(db: Db, workspaceId: string, email: string) {
  const users = await db.user.findMany({ where: { OR: [{ email }, { identities: { some: { email } } }] }, select: { id: true } });
  if (users.length === 0) return null;
  return db.member.findFirst({ where: { workspaceId, userId: { in: users.map((u) => u.id) } }, select: { status: true } });
}

async function deliver(to: { email: string; workspaceName: string; inviter: string; role: Role; token: string; expiresAt: Date }, s: Sender, undo: () => Promise<void>) {
  try {
    await s.mailer.send(invitationMail({ to: to.email, workspaceName: to.workspaceName, inviter: to.inviter, role: to.role, link: linkFor(s.origin, to.token), expiresAt: to.expiresAt }));
  } catch {
    // The address and the link stay out of the log. The invitation is withdrawn so the admin can simply try again.
    console.error("[invite] invitation email could not be delivered");
    await undo();
    throw new ValidationError("The invitation email could not be sent. Check the server's mail settings and try again.");
  }
}

/** Invites an address. Re-inviting an address replaces its pending invitation (new token, new role); the old link stops working. */
export async function createInvitation(db: Db, v: Viewer, input: { email: unknown; role: unknown } & Sender): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (input.role === "OWNER") throw new ValidationError("Ownership cannot be given by invitation. Invite them as Admin, then transfer ownership.");
  if (!isAssignableRole(input.role)) throw new ValidationError("Choose Admin, Member or Reader.");
  const role = input.role;
  const actor = await actorOf(db, v);
  if (!can(actor, "manageMembers", { newRole: role })) throw new ForbiddenError("Administrator only");

  const known = await memberForEmail(db, v.workspaceId, email);
  if (known?.status === "ACTIVE") throw new ConflictError("That person is already a member of this workspace.");
  if (known?.status === "REVOKED") throw new ConflictError("That person was removed from this workspace. Reinstate them from the list instead.");

  await spend(db, v, email, now);
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  let id: string;
  try {
    id = await db.$transaction(async (tx) => {
      await tx.invitation.updateMany({ where: { workspaceId: v.workspaceId, emailLowercased: email, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const row = await tx.invitation.create({ data: { workspaceId: v.workspaceId, emailLowercased: email, role, invitedByMemberId: v.memberId, tokenHash: sha256(token), expiresAt, createdAt: now }, select: { id: true } });
      await audit(tx, { workspaceId: v.workspaceId, userId: v.userId }, "invitation.created", { type: "Invitation", id: row.id }, { email, role });
      return row.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("An invitation to that address was just sent.");
    throw e;
  }
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: v.workspaceId }, select: { name: true } });
  await deliver({ email, workspaceName: ws.name, inviter: v.login, role, token, expiresAt }, { ...input, now }, async () => {
    await db.invitation.updateMany({ where: { id, workspaceId: v.workspaceId, acceptedAt: null }, data: { revokedAt: new Date() } });
  });
  return { id };
}

/** A fresh token for a pending invitation; the previous link no longer matches anything. */
export async function resendInvitation(db: Db, v: Viewer, invitationId: unknown, s: Sender): Promise<void> {
  const now = s.now ?? new Date();
  const actor = await actorOf(db, v);
  const inv = typeof invitationId === "string" ? await db.invitation.findFirst({ where: { id: invitationId, workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null } }) : null;
  if (!inv) throw new NotFoundError();
  if (!can(actor, "manageMembers", { newRole: inv.role })) throw new ForbiddenError("Administrator only");
  await spend(db, v, inv.emailLowercased, now);
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const r = await db.invitation.updateMany({ where: { id: inv.id, workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null }, data: { tokenHash: sha256(token), expiresAt } });
  if (r.count !== 1) throw new NotFoundError();
  await audit(db, { workspaceId: v.workspaceId, userId: v.userId }, "invitation.resent", { type: "Invitation", id: inv.id });
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: v.workspaceId }, select: { name: true } });
  await deliver({ email: inv.emailLowercased, workspaceName: ws.name, inviter: v.login, role: inv.role as Role, token, expiresAt }, { ...s, now }, async () => {
    await db.invitation.updateMany({ where: { id: inv.id, workspaceId: v.workspaceId, acceptedAt: null }, data: { revokedAt: new Date() } });
  });
}

export async function revokeInvitation(db: Db, v: Viewer, invitationId: unknown, now = new Date()): Promise<void> {
  const actor = await actorOf(db, v);
  const inv = typeof invitationId === "string" ? await db.invitation.findFirst({ where: { id: invitationId, workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null } }) : null;
  if (!inv) throw new NotFoundError();
  if (!can(actor, "manageMembers", { newRole: inv.role })) throw new ForbiddenError("Administrator only");
  const r = await db.invitation.updateMany({ where: { id: inv.id, workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
  if (r.count !== 1) throw new NotFoundError();
  await audit(db, { workspaceId: v.workspaceId, userId: v.userId }, "invitation.revoked", { type: "Invitation", id: inv.id });
}

export type InvitationRow = { id: string; email: string; role: Role; invitedBy: string | null; createdAt: Date; expiresAt: Date; expired: boolean };

/** Pending invitations (not accepted, not revoked), newest first. Never returns a token or its hash. */
export async function listInvitations(db: Db, v: Viewer, now = new Date()): Promise<InvitationRow[]> {
  if (!can(v, "manageMembers")) throw new ForbiddenError("Administrator only");
  const rows = await db.invitation.findMany({ where: { workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null }, include: { invitedBy: { include: { user: { select: { login: true } } } } }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ id: r.id, email: r.emailLowercased, role: r.role as Role, invitedBy: r.invitedBy?.user.login ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt, expired: r.expiresAt <= now }));
}

export type InvitePreview = { workspaceName: string; role: Role; email: string };

/**
 * What the invitation page may show someone holding a link. Missing, used, revoked and expired all answer null, so the page cannot be
 * used to learn which of those a token is.
 */
export async function previewInvitation(db: Db, token: unknown, now = new Date()): Promise<InvitePreview | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = await db.invitation.findUnique({ where: { tokenHash: sha256(token) }, select: { workspaceId: true, role: true, emailLowercased: true, acceptedAt: true, revokedAt: true, expiresAt: true, workspace: { select: { name: true } } } });
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= now) return null;
  return { workspaceName: row.workspace.name, role: row.role as Role, email: row.emailLowercased };
}

export type AcceptResult = { ok: true; workspaceId: string; already: boolean } | { ok: false; reason: "invalid" | "wrong-email" };

class Rollback extends Error {}

/**
 * Joins the signed-in user to the workspace. The single UPDATE ... WHERE acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now
 * RETURNING is the whole single-use check: of any number of simultaneous accepts exactly one claims the row, and the member row is
 * created in the same transaction (unique on workspace and user). The user's own address must be verified and equal the invited one.
 */
export async function acceptInvitation(db: Db, token: unknown, user: { id: string; email: string | null; emailVerifiedAt: Date | null }, now = new Date()): Promise<AcceptResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  const hash = sha256(token);
  const row = await db.invitation.findUnique({ where: { tokenHash: hash }, select: { workspaceId: true, emailLowercased: true, acceptedAt: true, revokedAt: true, expiresAt: true } });
  if (!row) return { ok: false, reason: "invalid" };
  const joined = async () => {
    const m = await db.member.findFirst({ where: { workspaceId: row.workspaceId, userId: user.id, status: "ACTIVE" }, select: { id: true } });
    return m ? ({ ok: true, workspaceId: row.workspaceId, already: true } as const) : null;
  };
  if (row.revokedAt || row.expiresAt <= now) return { ok: false, reason: "invalid" };
  if (row.acceptedAt) return (await joined()) ?? { ok: false, reason: "invalid" }; // a double click or a second device
  if (!user.email || !user.emailVerifiedAt || user.email !== row.emailLowercased) return { ok: false, reason: "wrong-email" };
  try {
    return await db.$transaction(async (tx): Promise<AcceptResult> => {
      const claimed = await tx.$queryRaw<{ id: string; workspaceId: string; role: string }[]>`
        UPDATE "Invitation" SET "acceptedAt" = ${now}
        WHERE "tokenHash" = ${hash} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > ${now}
        RETURNING "id", "workspaceId", "role"::text AS "role"`;
      if (claimed.length !== 1) throw new Rollback();
      const { id, workspaceId, role } = claimed[0];
      const existing = await tx.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } }, select: { id: true, status: true } });
      if (existing?.status === "REVOKED") throw new Rollback(); // removed after the invitation went out: an administrator reinstates them on purpose
      if (!existing) await tx.member.create({ data: { workspaceId, userId: user.id, role: role as Role, status: "ACTIVE" } });
      await audit(tx, { workspaceId, userId: user.id }, "invitation.accepted", { type: "Invitation", id }, { role });
      return { ok: true, workspaceId, already: existing?.status === "ACTIVE" };
    });
  } catch (e) {
    if (e instanceof Rollback || isUniqueViolation(e)) return (await joined()) ?? { ok: false, reason: "invalid" };
    throw e;
  }
}
