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
/**
 * perAdminPerHour / perWorkspacePerDay: per inviter and per workspace. perUserPerHour: per PERSON across all their memberships and
 * workspaces (a new workspace is a new budget otherwise). perRecipientPerDay: invitations to one address from ALL workspaces, so
 * nobody's inbox can be flooded by making workspaces. gapMs: one mail per (workspace, address) per minute.
 */
export const INVITE_LIMITS = { perAdminPerHour: 20, perUserPerHour: 30, perWorkspacePerDay: 100, perRecipientPerDay: 3, gapMs: 60_000 } as const;

type Tx = Prisma.TransactionClient;
type Sender = { mailer: Mailer; origin: string; now?: Date };

const linkFor = (origin: string, token: string) => `${origin}/invite/${token}`;

/** Per-admin and per-workspace budgets and a spacing per address, so one admin cannot turn the invite form into a mail cannon. */
async function spend(db: Db, v: Pick<Viewer, "memberId" | "workspaceId" | "userId">, email: string, now: Date) {
  if (!(await claimGap(db, `inv:gap:${sha256(`${v.workspaceId}|${email}`)}`, INVITE_LIMITS.gapMs, now))) throw new ConflictError("An invitation to that address was just sent. Wait a minute before sending another.");
  if (!(await take(db, `inv:to:${sha256(email)}`, INVITE_LIMITS.perRecipientPerDay, 24 * HOUR, now))) throw new ConflictError("That address has received several invitations today. Try again tomorrow.");
  if (!(await take(db, `inv:user:${v.userId}`, INVITE_LIMITS.perUserPerHour, HOUR, now))) throw new ConflictError("You have sent a lot of invitations. Try again in an hour.");
  if (!(await take(db, `inv:admin:${v.memberId}`, INVITE_LIMITS.perAdminPerHour, HOUR, now))) throw new ConflictError("You have sent a lot of invitations. Try again in an hour.");
  if (!(await take(db, `inv:ws:${v.workspaceId}`, INVITE_LIMITS.perWorkspacePerDay, 24 * HOUR, now))) throw new ConflictError("This workspace has sent many invitations today. Try again tomorrow.");
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

/** How long a request waits for the mail server before it answers. The send itself carries on in the background. */
export const MAIL_WAIT_MS = 2000;
/** sent: handed to the mail server; pending: still being sent when the request answered; failed: the server refused (the row says so, Resend retries). */
export type MailState = "sent" | "pending" | "failed";

/**
 * Sends the invitation mail AFTER the row is committed, and waits at most MAIL_WAIT_MS for the result. A failure never withdraws the
 * invitation: it is recorded on the row (`sendFailedAt`, shown as "email not sent" with Resend) so the admin sees it even when it
 * happened after the request had answered. The address and link never reach the log.
 */
async function deliver(db: Db, row: { id: string; workspaceId: string }, to: { email: string; workspaceName: string; inviter: string; role: Role; token: string; expiresAt: Date }, s: Sender): Promise<MailState> {
  const sending: Promise<MailState> = (async () => {
    try {
      await s.mailer.send(invitationMail({ to: to.email, workspaceName: to.workspaceName, inviter: to.inviter, role: to.role, link: linkFor(s.origin, to.token), expiresAt: to.expiresAt }));
      await db.invitation.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, sendFailedAt: { not: null } }, data: { sendFailedAt: null } });
      return "sent";
    } catch {
      console.error("[invite] invitation email could not be delivered");
      await db.invitation.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, acceptedAt: null }, data: { sendFailedAt: new Date() } }).catch(() => {});
      return "failed";
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<MailState>((resolve) => {
    timer = setTimeout(() => resolve("pending"), MAIL_WAIT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([sending, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/** Invites an address. Re-inviting an address replaces its pending invitation (new token, new role); the old link stops working. */
export async function createInvitation(db: Db, v: Viewer, input: { email: unknown; role: unknown } & Sender): Promise<{ id: string; email: string; mail: MailState }> {
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
  const mail = await deliver(db, { id, workspaceId: v.workspaceId }, { email, workspaceName: ws.name, inviter: v.login, role, token, expiresAt }, { ...input, now });
  return { id, email, mail };
}

/** A fresh token for a pending invitation; the previous link no longer matches anything. */
export async function resendInvitation(db: Db, v: Viewer, invitationId: unknown, s: Sender): Promise<{ email: string; mail: MailState }> {
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
  const mail = await deliver(db, { id: inv.id, workspaceId: v.workspaceId }, { email: inv.emailLowercased, workspaceName: ws.name, inviter: v.login, role: inv.role as Role, token, expiresAt }, { ...s, now });
  return { email: inv.emailLowercased, mail };
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

export type InvitationRow = { id: string; email: string; role: Role; invitedBy: string | null; createdAt: Date; expiresAt: Date; expired: boolean; sendFailed: boolean };

/** Pending invitations (not accepted, not revoked), newest first. Never returns a token or its hash. */
export async function listInvitations(db: Db, v: Viewer, now = new Date()): Promise<InvitationRow[]> {
  if (!can(v, "manageMembers")) throw new ForbiddenError("Administrator only");
  const rows = await db.invitation.findMany({ where: { workspaceId: v.workspaceId, acceptedAt: null, revokedAt: null }, include: { invitedBy: { include: { user: { select: { login: true } } } } }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ id: r.id, email: r.emailLowercased, role: r.role as Role, invitedBy: r.invitedBy?.user.login ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt, expired: r.expiresAt <= now, sendFailed: r.sendFailedAt !== null }));
}

/** The person who sent an invitation must still be an ACTIVE member who may invite that role; otherwise their invitations are dead. */
async function inviterStillAllowed(db: Db | Tx, workspaceId: string, inviterId: string | null, role: string, lock = false): Promise<boolean> {
  if (!inviterId) return false;
  const rows = lock
    ? await (db as Tx).$queryRaw<{ role: string; status: string }[]>`SELECT "role"::text AS "role", "status"::text AS "status" FROM "Member" WHERE "id" = ${inviterId} AND "workspaceId" = ${workspaceId} FOR SHARE`
    : (await db.member.findMany({ where: { id: inviterId, workspaceId }, select: { role: true, status: true } })).map((m) => ({ role: m.role as string, status: m.status as string }));
  return rows.length === 1 && can({ role: rows[0].role, status: rows[0].status }, "manageMembers", { newRole: role });
}

/**
 * Invitations waiting for this person: pending, unexpired, sent to THEIR VERIFIED address by someone who may still invite. Only a user
 * with a verified email gets any (an unverified or GitHub-only account proves nothing). Shown on onboarding so an invitee does not
 * create a stray workspace; joining still needs a click.
 */
export async function pendingInvitationsFor(db: Db, user: Joiner, now = new Date()): Promise<{ id: string; workspaceName: string; role: Role }[]> {
  if (!user.email || !user.emailVerifiedAt) return [];
  const rows = await db.invitation.findMany({
    where: { emailLowercased: user.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, workspaceId: true, role: true, invitedByMemberId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const out: { id: string; workspaceName: string; role: Role }[] = [];
  for (const r of rows) if (await inviterStillAllowed(db, r.workspaceId, r.invitedByMemberId, r.role)) out.push({ id: r.id, workspaceName: r.workspace.name, role: r.role as Role });
  return out;
}

export type InvitePreview = { workspaceName: string; role: Role; email: string };

/**
 * What the invitation page may show someone holding a link. Missing, used, revoked and expired all answer null, so the page cannot be
 * used to learn which of those a token is.
 */
export async function previewInvitation(db: Db, token: unknown, now = new Date()): Promise<InvitePreview | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = await db.invitation.findUnique({ where: { tokenHash: sha256(token) }, select: { workspaceId: true, role: true, emailLowercased: true, invitedByMemberId: true, acceptedAt: true, revokedAt: true, expiresAt: true, workspace: { select: { name: true } } } });
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= now) return null;
  if (!(await inviterStillAllowed(db, row.workspaceId, row.invitedByMemberId, row.role))) return null;
  return { workspaceName: row.workspace.name, role: row.role as Role, email: row.emailLowercased };
}

export type AcceptResult = { ok: true; workspaceId: string; already: boolean } | { ok: false; reason: "invalid" | "wrong-email" };

class Rollback extends Error {}

/**
 * Joins the signed-in user to the workspace. The single UPDATE ... WHERE acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now
 * RETURNING is the whole single-use check: of any number of simultaneous accepts exactly one claims the row, and the member row is
 * created in the same transaction (unique on workspace and user). The user's own address must be verified and equal the invited one.
 */
type Joiner = { id: string; email: string | null; emailVerifiedAt: Date | null };

export async function acceptInvitation(db: Db, token: unknown, user: Joiner, now = new Date()): Promise<AcceptResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  return acceptRow(db, { tokenHash: sha256(token) }, user, now);
}

/**
 * Accepts an invitation listed to the signed-in user on the onboarding page, which has no token: the row id stands in for it. The same
 * rules apply (the user's verified address must equal the invited one, single-use claim, inviter still allowed); an id of someone else's
 * invitation fails as "wrong-email", an unknown id as "invalid".
 */
export async function acceptInvitationById(db: Db, invitationId: unknown, user: Joiner, now = new Date()): Promise<AcceptResult> {
  if (typeof invitationId !== "string" || invitationId.length < 5 || invitationId.length > 100) return { ok: false, reason: "invalid" };
  return acceptRow(db, { id: invitationId }, user, now);
}

async function acceptRow(db: Db, key: { tokenHash: string } | { id: string }, user: Joiner, now: Date): Promise<AcceptResult> {
  const row = await db.invitation.findUnique({ where: key, select: { id: true, workspaceId: true, emailLowercased: true, acceptedAt: true, revokedAt: true, expiresAt: true } });
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
      const claimed = await tx.$queryRaw<{ id: string; workspaceId: string; invitedByMemberId: string | null; role: string }[]>`
        UPDATE "Invitation" SET "acceptedAt" = ${now}
        WHERE "id" = ${row.id} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > ${now}
        RETURNING "id", "workspaceId", "invitedByMemberId", "role"::text AS "role"`;
      if (claimed.length !== 1) throw new Rollback();
      const { id, workspaceId, role, invitedByMemberId } = claimed[0];
      if (!(await inviterStillAllowed(tx, workspaceId, invitedByMemberId, role, true))) throw new Rollback(); // the inviter was removed or demoted since: the invitation died with their access
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
