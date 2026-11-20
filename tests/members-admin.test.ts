import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { addMember, sessionIn, workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { createWorkspaceFor } from "@/lib/auth/workspaces";
import { findSession } from "@/lib/auth/session";
import { resolveActiveWorkspaceId, selectWorkspace } from "@/lib/authz/active-workspace";
import { loadViewer, requireRepo, requireWrite } from "@/lib/authz/viewer";
import { changeRole, leaveWorkspace, listMembers, reinstateMember, removeMember, transferOwnership } from "@/lib/services/members";
import { createRestrictedSpace, setSpaceMember } from "@/lib/services/access-spaces";
import { person, tokenOf } from "./roles-helpers";
import { ORIGIN, RecordingMailer } from "./auth-mocks";
import { acceptInvitation, createInvitation, previewInvitation } from "@/lib/services/invitations";

let db: Db;
let n = 0;
beforeEach(() => {
  db = createTestPrisma(`members-admin-${n++}`);
});

const roleOf = async (memberId: string) => (await db.member.findUniqueOrThrow({ where: { id: memberId } })).role;
const owners = (workspaceId: string) => db.member.count({ where: { workspaceId, role: "OWNER" } });

async function team(tag = "") {
  const w = await workspaceWithOwner(db, `${tag}owner@example.com`);
  const admin = await addMember(db, w.ws.id, `${tag}admin@example.com`, "ADMIN");
  const admin2 = await addMember(db, w.ws.id, `${tag}admin2@example.com`, "ADMIN");
  const member = await addMember(db, w.ws.id, `${tag}member@example.com`, "MEMBER");
  const reader = await addMember(db, w.ws.id, `${tag}reader@example.com`, "READER");
  const ownerMember = await db.member.findFirstOrThrow({ where: { workspaceId: w.ws.id, userId: w.owner.id } });
  return { ...w, admin, admin2, member, reader, ownerMember };
}

describe("a new workspace", () => {
  it("makes its creator the single OWNER, and creates the COMMON space", async () => {
    const { ws, ownerMember, viewer } = await team();
    expect(ownerMember.role).toBe("OWNER");
    expect(viewer.role).toBe("OWNER");
    expect(viewer.isAdmin).toBe(true);
    expect(await owners(ws.id)).toBe(1);
    expect(await db.accessSpace.findMany({ where: { workspaceId: ws.id } })).toMatchObject([{ kind: "COMMON" }]);
  });

  it("the database refuses a second OWNER (partial unique index), in the same workspace only", async () => {
    const { ws, admin } = await team();
    await expect(db.member.update({ where: { id: admin.member.id }, data: { role: "OWNER" } })).rejects.toThrow();
    const other = await workspaceWithOwner(db, "owner-b@example.com", "B");
    expect(await owners(other.ws.id)).toBe(1);
    expect(await owners(ws.id)).toBe(1);
  });

  it("the migration made each existing workspace's oldest ADMIN its OWNER (oldest member when it had no ADMIN)", async () => {
    const sql = fs.readFileSync(path.resolve("prisma/migrations/20261121100000_roles_invitations_spaces/migration.sql"), "utf8");
    const backfill = /^UPDATE "Member" SET "role" = 'OWNER'[\s\S]*?\);\r?\n/m.exec(sql)![0];
    const index = /CREATE UNIQUE INDEX "Member_one_owner"[^\n]*;/.exec(sql)![0];
    // Rebuild the pre-migration situation: no owners at all, mixed roles and ages.
    await db.$executeRawUnsafe(`DROP INDEX "Member_one_owner"`);
    const mk = async (name: string) => (await db.workspace.create({ data: { name } })).id;
    const u = async (e: string) => (await person(db, e)).id;
    const at = (d: number) => new Date(2026, 0, d);
    const w1 = await mk("w1");
    const w2 = await mk("w2");
    const w3 = await mk("w3");
    const m = (workspaceId: string, userId: string, role: "ADMIN" | "MEMBER", createdAt: Date) => db.member.create({ data: { workspaceId, userId, role, createdAt } });
    const w1m = await m(w1, await u("w1m@x.com"), "MEMBER", at(1)); // oldest, but not an admin
    const w1a1 = await m(w1, await u("w1a1@x.com"), "ADMIN", at(2)); // the oldest ADMIN
    const w1a2 = await m(w1, await u("w1a2@x.com"), "ADMIN", at(3));
    const w2o = await m(w2, await u("w2o@x.com"), "MEMBER", at(5)); // no admin: the oldest member
    const w2y = await m(w2, await u("w2y@x.com"), "MEMBER", at(6));
    const w3a = await m(w3, await u("w3a@x.com"), "ADMIN", at(7)); // the only member
    const w4 = await mk("w4");
    const w4gone = await m(w4, await u("w4gone@x.com"), "ADMIN", at(8)); // the oldest ADMIN, but removed
    await db.member.update({ where: { id: w4gone.id }, data: { status: "REVOKED", revokedAt: at(9) } });
    const w4a = await m(w4, await u("w4a@x.com"), "ADMIN", at(10));
    const w4m = await m(w4, await u("w4m@x.com"), "MEMBER", at(9));
    const w5 = await mk("w5"); // every member removed: nobody is made OWNER
    const w5gone = await m(w5, await u("w5gone@x.com"), "ADMIN", at(11));
    await db.member.update({ where: { id: w5gone.id }, data: { status: "REVOKED", revokedAt: at(12) } });
    const w6 = await mk("w6"); // no ACTIVE admin: the oldest ACTIVE member, not the removed admin
    const w6gone = await m(w6, await u("w6gone@x.com"), "ADMIN", at(13));
    await db.member.update({ where: { id: w6gone.id }, data: { status: "REVOKED", revokedAt: at(14) } });
    const w6m = await m(w6, await u("w6m@x.com"), "MEMBER", at(15));
    await db.$executeRawUnsafe(backfill);
    await db.$executeRawUnsafe(index);
    expect(await roleOf(w1a1.id)).toBe("OWNER");
    expect(await roleOf(w1a2.id)).toBe("ADMIN");
    expect(await roleOf(w1m.id)).toBe("MEMBER");
    expect(await roleOf(w2o.id)).toBe("OWNER");
    expect(await roleOf(w2y.id)).toBe("MEMBER");
    expect(await roleOf(w3a.id)).toBe("OWNER");
    expect(await roleOf(w4gone.id)).toBe("ADMIN"); // a removed admin is never the owner
    expect(await roleOf(w4a.id)).toBe("OWNER");
    expect(await roleOf(w4m.id)).toBe("MEMBER");
    expect(await roleOf(w5gone.id)).toBe("ADMIN");
    expect(await owners(w5)).toBe(0); // no active member: left without an owner on purpose (docs/roles.md)
    expect(await roleOf(w6gone.id)).toBe("ADMIN");
    expect(await roleOf(w6m.id)).toBe("OWNER");
    for (const w of [w1, w2, w3, w4, w6]) expect(await owners(w)).toBe(1);
  });
});

describe("who may change what", () => {
  it("ADMIN cannot demote, remove or re-role the OWNER, nor promote anyone to OWNER", async () => {
    const t = await team();
    const v = await t.admin.viewer();
    await expect(changeRole(db, v, t.ownerMember.id, "MEMBER")).rejects.toThrow(ForbiddenError);
    await expect(removeMember(db, v, t.ownerMember.id)).rejects.toThrow(ForbiddenError);
    await expect(changeRole(db, v, t.member.member.id, "OWNER")).rejects.toThrow(ValidationError);
    expect(await roleOf(t.ownerMember.id)).toBe("OWNER");
    expect(await owners(t.ws.id)).toBe(1);
  });

  it("OWNER cannot hand out OWNER by changing a role either; the owner cannot be removed or demoted by anyone", async () => {
    const t = await team();
    await expect(changeRole(db, t.viewer, t.admin.member.id, "OWNER")).rejects.toThrow(ValidationError);
    await expect(changeRole(db, t.viewer, t.ownerMember.id, "ADMIN")).rejects.toThrow(/transferring ownership/);
    await expect(removeMember(db, t.viewer, t.ownerMember.id)).rejects.toThrow(/Use Leave|cannot be removed/);
  });

  it("ADMIN changes MEMBER, READER and other ADMINs; the change is recorded", async () => {
    const t = await team();
    const v = await t.admin.viewer();
    await changeRole(db, v, t.member.member.id, "READER");
    expect(await roleOf(t.member.member.id)).toBe("READER");
    await changeRole(db, v, t.reader.member.id, "ADMIN");
    expect(await roleOf(t.reader.member.id)).toBe("ADMIN");
    await changeRole(db, v, t.admin2.member.id, "MEMBER");
    expect(await roleOf(t.admin2.member.id)).toBe("MEMBER");
    expect(await db.auditLog.count({ where: { workspaceId: t.ws.id, action: "member.role" } })).toBe(3);
  });

  it("MEMBER and READER cannot administer anyone", async () => {
    const t = await team();
    for (const who of [t.member, t.reader]) {
      const v = await who.viewer();
      await expect(changeRole(db, v, t.admin2.member.id, "READER")).rejects.toThrow(ForbiddenError);
      await expect(removeMember(db, v, t.admin2.member.id)).rejects.toThrow(ForbiddenError);
      await expect(listMembers(db, v)).rejects.toThrow(ForbiddenError);
      await expect(transferOwnership(db, v, t.admin.member.id)).rejects.toThrow(ForbiddenError);
    }
  });

  it("a member id from ANOTHER workspace is not found, never changed", async () => {
    const a = await team();
    const b = await workspaceWithOwner(db, "boss-b@example.com", "B");
    const victim = await addMember(db, b.ws.id, "victim@example.com", "MEMBER");
    await expect(changeRole(db, a.viewer, victim.member.id, "READER")).rejects.toThrow(NotFoundError);
    await expect(removeMember(db, a.viewer, victim.member.id)).rejects.toThrow(NotFoundError);
    await expect(transferOwnership(db, a.viewer, victim.member.id)).rejects.toThrow(NotFoundError);
    expect(await roleOf(victim.member.id)).toBe("MEMBER");
  });

  it("a stale viewer (demoted since it was loaded) cannot use its old powers", async () => {
    const t = await team();
    const stale = await t.admin.viewer();
    await changeRole(db, t.viewer, t.admin.member.id, "MEMBER");
    await expect(changeRole(db, stale, t.reader.member.id, "MEMBER")).rejects.toThrow(ForbiddenError);
    expect(await roleOf(t.reader.member.id)).toBe("READER");
  });

  it("READER is read-only through the viewer helpers", async () => {
    const t = await team();
    const v = await t.reader.viewer();
    expect(v.role).toBe("READER");
    expect(v.isAdmin).toBe(false);
    expect(() => requireWrite(v)).toThrow(ForbiddenError);
    expect(() => requireWrite(t.viewer)).not.toThrow();
    const owner = await db.githubOwner.create({ data: { githubId: 5n, login: "o" } });
    const repo = await db.repository.create({ data: { workspaceId: t.ws.id, githubId: 1n, ownerId: owner.id, name: "r", fullName: "o/r", htmlUrl: "https://github.com/o/r", visibility: "PRIVATE" } });
    await db.repositoryGrant.create({ data: { memberId: t.reader.member.id, repositoryId: repo.id, canManageWork: true, canReview: true, grantedById: t.ownerMember.id } });
    await requireRepo(db, v, repo.id, "view");
    await expect(requireRepo(db, v, repo.id, "manageWork")).rejects.toThrow(ForbiddenError); // even with the grant flag set
    await expect(requireRepo(db, v, repo.id, "review")).rejects.toThrow(ForbiddenError);
  });
});

describe("removal ends access at once", () => {
  it("a REVOKED member: the viewer no longer loads, the session binding no longer resolves, memberships are gone", async () => {
    const t = await team();
    const sess = await sessionIn(db, t.member.user.id, t.ws.id);
    expect((await findSession(db, "nope"))).toBeNull();
    expect(await resolveActiveWorkspaceId(db, t.member.user, sess.activeWorkspaceId)).toBe(t.ws.id);
    const project = await db.project.create({ data: { workspaceId: t.ws.id, name: "P", slug: "p" } });
    await db.projectMember.create({ data: { projectId: project.id, memberId: t.member.member.id } });
    const space = await createRestrictedSpace(db, t.viewer, "Secret");
    await setSpaceMember(db, t.viewer, space.id, t.member.member.id, true);

    await removeMember(db, t.viewer, t.member.member.id);

    expect(await loadViewer(db, t.member.user.id, t.ws.id)).toBeNull();
    expect(await loadViewer(db, t.member.user.id)).toBeNull();
    const after = await db.session.findUniqueOrThrow({ where: { id: sess.id } });
    expect(after.activeWorkspaceId).toBeNull();
    expect(await resolveActiveWorkspaceId(db, t.member.user, t.ws.id)).toBeNull(); // not even the old cookie value brings it back
    expect(await selectWorkspace(db, after, t.ws.id)).toBe(false);
    expect(await db.projectMember.count({ where: { memberId: t.member.member.id } })).toBe(0);
    expect(await db.accessSpaceMember.count({ where: { memberId: t.member.member.id } })).toBe(0);
    expect(await db.member.findUniqueOrThrow({ where: { id: t.member.member.id } })).toMatchObject({ status: "REVOKED" });
    expect((await db.member.findUniqueOrThrow({ where: { id: t.member.member.id } })).revokedAt).not.toBeNull();
    // the person's data stays: authorship still points at them
    expect(await db.user.findUnique({ where: { id: t.member.user.id } })).not.toBeNull();
  });

  it("their other workspace and its session binding are untouched", async () => {
    const t = await team();
    const other = await createWorkspaceFor(db, t.member.user.id, "Second");
    const inFirst = await sessionIn(db, t.member.user.id, t.ws.id);
    const inSecond = await sessionIn(db, t.member.user.id, other.id);
    await removeMember(db, t.viewer, t.member.member.id);
    expect((await db.session.findUniqueOrThrow({ where: { id: inFirst.id } })).activeWorkspaceId).toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: inSecond.id } })).activeWorkspaceId).toBe(other.id);
    expect((await loadViewer(db, t.member.user.id, other.id))?.role).toBe("OWNER");
    expect(await resolveActiveWorkspaceId(db, t.member.user, t.ws.id)).toBe(other.id); // falls to the workspace they still belong to
    expect(await db.member.count({ where: { workspaceId: other.id, status: "ACTIVE" } })).toBe(1);
    // and the first workspace's own people are unchanged
    expect(await db.member.count({ where: { workspaceId: t.ws.id, status: "ACTIVE" } })).toBe(4);
  });

  it("reinstating returns the person with the chosen role and none of their old space or project memberships", async () => {
    const t = await team();
    const space = await createRestrictedSpace(db, t.viewer, "Secret");
    await setSpaceMember(db, t.viewer, space.id, t.member.member.id, true);
    await removeMember(db, t.viewer, t.member.member.id);
    await expect(reinstateMember(db, t.viewer, t.member.member.id, "OWNER")).rejects.toThrow(ValidationError);
    await reinstateMember(db, t.viewer, t.member.member.id, "READER");
    expect((await loadViewer(db, t.member.user.id, t.ws.id))?.role).toBe("READER");
    expect(await db.accessSpaceMember.count({ where: { memberId: t.member.member.id } })).toBe(0);
    await expect(reinstateMember(db, t.viewer, t.member.member.id, "MEMBER")).rejects.toThrow(ConflictError); // not removed any more
    const v = await t.reader.viewer();
    await expect(reinstateMember(db, v, t.member.member.id)).rejects.toThrow(ForbiddenError);
  });

  it("leaving: anyone but the OWNER may leave, and it ends access like a removal", async () => {
    const t = await team();
    await expect(leaveWorkspace(db, t.viewer)).rejects.toThrow(/owner cannot leave/);
    expect(await roleOf(t.ownerMember.id)).toBe("OWNER");
    const sess = await sessionIn(db, t.reader.user.id, t.ws.id);
    await leaveWorkspace(db, await t.reader.viewer()); // a reader may leave
    expect(await loadViewer(db, t.reader.user.id, t.ws.id)).toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: sess.id } })).activeWorkspaceId).toBeNull();
    await leaveWorkspace(db, await t.admin.viewer());
    expect(await db.member.count({ where: { workspaceId: t.ws.id, status: "ACTIVE" } })).toBe(3);
  });

  it("removing yourself goes through Leave; removing someone twice is a conflict", async () => {
    const t = await team();
    await expect(removeMember(db, t.viewer, t.ownerMember.id)).rejects.toThrow(ValidationError);
    await removeMember(db, t.viewer, t.reader.member.id);
    await expect(removeMember(db, t.viewer, t.reader.member.id)).rejects.toThrow(ConflictError);
  });
});

describe("transfer ownership", () => {
  it("swaps OWNER and ADMIN atomically: still exactly one OWNER, the old owner is an ADMIN", async () => {
    const t = await team();
    await transferOwnership(db, t.viewer, t.admin.member.id);
    expect(await roleOf(t.admin.member.id)).toBe("OWNER");
    expect(await roleOf(t.ownerMember.id)).toBe("ADMIN");
    expect(await owners(t.ws.id)).toBe(1);
    expect((await loadViewer(db, t.owner.id, t.ws.id))?.role).toBe("ADMIN"); // the former owner keeps working as an admin
    // the former owner cannot transfer again; the new one can
    await expect(transferOwnership(db, await loadViewer(db, t.owner.id, t.ws.id).then((v) => v!), t.admin2.member.id)).rejects.toThrow(ForbiddenError);
    await transferOwnership(db, (await t.admin.viewer()), t.ownerMember.id);
    expect(await roleOf(t.ownerMember.id)).toBe("OWNER");
    expect(await owners(t.ws.id)).toBe(1);
  });

  it("only to an ACTIVE ADMIN: a MEMBER, a READER, a removed ADMIN, yourself and a stranger are refused and nothing changes", async () => {
    const t = await team();
    const removedAdmin = await addMember(db, t.ws.id, "gone@example.com", "ADMIN");
    await removeMember(db, t.viewer, removedAdmin.member.id);
    for (const id of [t.member.member.id, t.reader.member.id, removedAdmin.member.id]) await expect(transferOwnership(db, t.viewer, id)).rejects.toThrow(ConflictError);
    await expect(transferOwnership(db, t.viewer, t.ownerMember.id)).rejects.toThrow(ValidationError);
    await expect(transferOwnership(db, t.viewer, "nope")).rejects.toThrow(NotFoundError);
    expect(await roleOf(t.ownerMember.id)).toBe("OWNER");
    expect(await owners(t.ws.id)).toBe(1);
  });

  it("two simultaneous transfers: one wins, the other fails, and there is exactly one OWNER at the end", async () => {
    const t = await team();
    const results = await Promise.allSettled([transferOwnership(db, t.viewer, t.admin.member.id), transferOwnership(db, t.viewer, t.admin2.member.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await owners(t.ws.id)).toBe(1);
    const roles = (await db.member.findMany({ where: { workspaceId: t.ws.id }, select: { id: true, role: true } })).filter((m) => m.role === "OWNER");
    expect(roles[0].id).not.toBe(t.ownerMember.id);
  });

  it("another workspace's roles are not touched", async () => {
    const t = await team();
    const b = await workspaceWithOwner(db, "boss-b@example.com", "B");
    const bAdmin = await addMember(db, b.ws.id, "badmin@example.com", "ADMIN");
    await transferOwnership(db, t.viewer, t.admin.member.id);
    expect(await owners(b.ws.id)).toBe(1);
    expect((await loadViewer(db, b.owner.id, b.ws.id))?.role).toBe("OWNER");
    expect(await roleOf(bAdmin.member.id)).toBe("ADMIN");
  });
});

describe("concurrent member administration never leaves a workspace without an OWNER", () => {
  const rounds = [0, 1, 2, 3, 4];
  it("transfer racing with a removal of the new owner", async () => {
    for (const i of rounds) {
      const t = await team(`r${i}`);
      const other = await t.admin2.viewer();
      await Promise.allSettled([transferOwnership(db, t.viewer, t.admin.member.id), removeMember(db, other, t.admin.member.id)]);
      expect(await owners(t.ws.id)).toBe(1);
      const owner = await db.member.findFirstOrThrow({ where: { workspaceId: t.ws.id, role: "OWNER" } });
      expect(owner.status).toBe("ACTIVE");
    }
  });

  it("transfer racing with a demotion of the new owner", async () => {
    for (const i of rounds) {
      const t = await team(`d${i}`);
      const other = await t.admin2.viewer();
      await Promise.allSettled([transferOwnership(db, t.viewer, t.admin.member.id), changeRole(db, other, t.admin.member.id, "READER")]);
      expect(await owners(t.ws.id)).toBe(1);
      expect((await db.member.findFirstOrThrow({ where: { workspaceId: t.ws.id, role: "OWNER" } })).status).toBe("ACTIVE");
    }
  });

  it("transfer racing with the new owner leaving", async () => {
    for (const i of rounds) {
      const t = await team(`l${i}`);
      const target = await t.admin.viewer();
      await Promise.allSettled([transferOwnership(db, t.viewer, t.admin.member.id), leaveWorkspace(db, target)]);
      expect(await owners(t.ws.id)).toBe(1);
      expect((await db.member.findFirstOrThrow({ where: { workspaceId: t.ws.id, role: "OWNER" } })).status).toBe("ACTIVE");
    }
  });
});

describe("a removed or demoted inviter leaves no live invitations", () => {
  const mailer = new RecordingMailer();
  const invite = (v: Parameters<typeof createInvitation>[1], email: string, role = "MEMBER") => createInvitation(db, v, { email, role, mailer, origin: ORIGIN });
  const accept = async (email: string, token: string) => {
    const u = (await db.user.findUnique({ where: { email } })) ?? (await person(db, email));
    return acceptInvitation(db, token, { id: u.id, email: u.email, emailVerifiedAt: u.emailVerifiedAt });
  };

  it("removing the inviter revokes their pending invitations; accepting one is refused", async () => {
    const t = await team("i");
    const v = await t.admin.viewer();
    await invite(v, "guest1@example.com");
    const token = tokenOf(mailer);
    await invite(t.viewer, "guest2@example.com"); // the owner's own invitation stays
    const keep = tokenOf(mailer);
    await removeMember(db, t.viewer, t.admin.member.id);
    expect(await db.invitation.count({ where: { workspaceId: t.ws.id, acceptedAt: null, revokedAt: null } })).toBe(1);
    expect(await accept("guest1@example.com", token)).toEqual({ ok: false, reason: "invalid" });
    expect((await accept("guest2@example.com", keep)).ok).toBe(true);
  });

  it("demoting the inviter below ADMIN revokes theirs too; a demotion that keeps ADMIN does not", async () => {
    const t = await team("j");
    const v = await t.admin.viewer();
    await invite(v, "g1@example.com");
    await changeRole(db, t.viewer, t.admin.member.id, "ADMIN");
    expect(await db.invitation.count({ where: { workspaceId: t.ws.id, acceptedAt: null, revokedAt: null } })).toBe(1);
    await changeRole(db, t.viewer, t.admin.member.id, "MEMBER");
    expect(await db.invitation.count({ where: { workspaceId: t.ws.id, acceptedAt: null, revokedAt: null } })).toBe(0);
  });

  it("even a row that somehow stayed pending cannot be accepted once its inviter is no longer allowed (checked at accept time)", async () => {
    const t = await team("k");
    const v = await t.admin.viewer();
    await invite(v, "late@example.com");
    const token = tokenOf(mailer);
    await db.member.update({ where: { id: t.admin.member.id }, data: { role: "MEMBER" } }); // bypasses the service: no revocation happened
    expect(await previewInvitation(db, token)).toBeNull();
    expect(await accept("late@example.com", token)).toEqual({ ok: false, reason: "invalid" });
    await db.member.update({ where: { id: t.admin.member.id }, data: { role: "ADMIN" } });
    expect(await previewInvitation(db, token)).not.toBeNull(); // the claim rolled back: it works again for an allowed inviter
    expect((await accept("late@example.com", token)).ok).toBe(true);
  });

  it("an invitation whose inviter row is gone or removed cannot be accepted", async () => {
    const t = await team("m");
    await invite(await t.admin.viewer(), "x1@example.com");
    const token = tokenOf(mailer);
    await db.member.update({ where: { id: t.admin.member.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect(await accept("x1@example.com", token)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("the member list", () => {
  it("lists active people first by role, then removed, with a self marker; administrators only", async () => {
    const t = await team();
    await removeMember(db, t.viewer, t.reader.member.id);
    const rows = await listMembers(db, t.viewer);
    expect(rows.map((r) => `${r.role}:${r.status}`)).toEqual(["OWNER:ACTIVE", "ADMIN:ACTIVE", "ADMIN:ACTIVE", "MEMBER:ACTIVE", "READER:REVOKED"]);
    expect(rows.filter((r) => r.isSelf)).toHaveLength(1);
  });
});
