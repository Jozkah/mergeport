import { beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, RecordingMailer } from "./auth-mocks";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { loadViewer } from "@/lib/authz/viewer";
import { acceptInvitationById, createInvitation, pendingInvitationsFor, revokeInvitation } from "@/lib/services/invitations";
import { removeMember } from "@/lib/services/members";

let db: Db;
let n = 0;
let mailer: RecordingMailer;
beforeEach(() => {
  db = createTestPrisma(`pending-invitations-${n++}`);
  mailer = new RecordingMailer();
});

const send = (v: Parameters<typeof createInvitation>[1], email: string, role = "MEMBER", now?: Date) => createInvitation(db, v, { email, role, mailer, origin: ORIGIN, now });
const asJoiner = (u: { id: string; email: string | null; emailVerifiedAt: Date | null }) => ({ id: u.id, email: u.email, emailVerifiedAt: u.emailVerifiedAt });

describe("a signed-in invitee with no workspace sees the invitation on onboarding", () => {
  it("lists pending invitations for the verified address, and Join accepts by id", async () => {
    const a = await workspaceWithOwner(db, "boss@example.com", "Acme");
    const b = await workspaceWithOwner(db, "boss2@example.com", "Beta");
    await send(a.viewer, "ivy@example.com", "READER");
    await send(b.viewer, "ivy@example.com", "ADMIN");
    await send(a.viewer, "someone-else@example.com");
    const ivy = await person(db, "ivy@example.com");
    const list = await pendingInvitationsFor(db, asJoiner(ivy));
    expect(list.map((i) => `${i.workspaceName}:${i.role}`).sort()).toEqual(["Acme:READER", "Beta:ADMIN"]);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    const acme = list.find((i) => i.workspaceName === "Acme")!;
    const r = await acceptInvitationById(db, acme.id, asJoiner(ivy));
    expect(r).toMatchObject({ ok: true, already: false });
    expect((await loadViewer(db, ivy.id, a.ws.id))?.role).toBe("READER");
    expect((await pendingInvitationsFor(db, asJoiner(ivy))).map((i) => i.workspaceName)).toEqual(["Beta"]);
  });

  it("nothing is listed for an unverified address, a GitHub-only account, an expired, revoked or inviter-removed invitation", async () => {
    const w = await workspaceWithOwner(db, "boss@example.com", "Acme");
    const t0 = new Date(Date.now() - 8 * 24 * 3600_000);
    await send(w.viewer, "old@example.com", "MEMBER", t0); // sent 8 days ago: expired
    const { id: revokedId } = await send(w.viewer, "rev@example.com");
    await revokeInvitation(db, w.viewer, revokedId);
    const admin = await addMember(db, w.ws.id, "admin@example.com", "ADMIN");
    await send(await admin.viewer(), "orphan@example.com");
    await send(w.viewer, "typed@example.com");
    await removeMember(db, w.viewer, admin.member.id); // revokes the admin's invitation
    const verified = (e: string) => person(db, e);
    for (const e of ["old@example.com", "rev@example.com", "orphan@example.com"]) expect(await pendingInvitationsFor(db, asJoiner(await verified(e)))).toEqual([]);
    const typed = await db.user.create({ data: { login: "typed", email: "typed@example.com" } }); // never verified
    expect(await pendingInvitationsFor(db, asJoiner(typed))).toEqual([]);
    const gh = await db.user.create({ data: { login: "gh", githubId: 7n } });
    expect(await pendingInvitationsFor(db, asJoiner(gh))).toEqual([]);
  });

  it("accepting by id follows the same rules: someone else's id is refused, an unknown id is invalid, and it is single-use", async () => {
    const w = await workspaceWithOwner(db, "boss@example.com", "Acme");
    await send(w.viewer, "kim@example.com");
    const kim = await person(db, "kim@example.com");
    const [inv] = await pendingInvitationsFor(db, asJoiner(kim));
    const mallory = await person(db, "mallory@example.com");
    expect(await acceptInvitationById(db, inv.id, asJoiner(mallory))).toEqual({ ok: false, reason: "wrong-email" });
    expect(await acceptInvitationById(db, "nope-nope-nope", asJoiner(kim))).toEqual({ ok: false, reason: "invalid" });
    expect(await acceptInvitationById(db, 5, asJoiner(kim))).toEqual({ ok: false, reason: "invalid" });
    expect((await acceptInvitationById(db, inv.id, asJoiner(kim))).ok).toBe(true);
    expect(await acceptInvitationById(db, inv.id, asJoiner(mallory))).toEqual({ ok: false, reason: "invalid" });
    expect(await db.member.count({ where: { workspaceId: w.ws.id } })).toBe(2);
  });
});
