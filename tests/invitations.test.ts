import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { NONCE, ORIGIN, RecordingMailer } from "./auth-mocks";
import { addMember, person, tokenOf, workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { sha256 } from "@/lib/crypto";
import { loadViewer } from "@/lib/authz/viewer";
import { consumeMagicLink, requestMagicLink } from "@/lib/auth/magic-link";
import { take } from "@/lib/auth/rate-limit";
import { INVITE_LIMITS, INVITE_TTL_MS, MAIL_WAIT_MS, acceptInvitation, createInvitation, listInvitations, previewInvitation, resendInvitation, revokeInvitation } from "@/lib/services/invitations";
import { removeMember } from "@/lib/services/members";

let db: Db;
let n = 0;
let mailer: RecordingMailer;
beforeEach(() => {
  db = createTestPrisma(`invitations-${n++}`);
  mailer = new RecordingMailer();
});

const send = (viewer: Parameters<typeof createInvitation>[1], email: string, role: unknown = "MEMBER", now?: Date) => createInvitation(db, viewer, { email, role, mailer, origin: ORIGIN, now });
const asUser = async (email: string) => {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, email: u.email, emailVerifiedAt: u.emailVerifiedAt };
};
const members = (workspaceId: string) => db.member.findMany({ where: { workspaceId } });

describe("sending", () => {
  it("mails a link to /invite/<token>, stores only the hash, never lists a token", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "Alice@Example.com", "READER");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("alice@example.com");
    expect(mailer.sent[0].subject).toContain("Acme");
    expect(mailer.sent[0].text).toContain("Reader");
    const token = tokenOf(mailer);
    expect(mailer.link()).toBe(`${ORIGIN}/invite/${token}`);
    const row = await db.invitation.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(7 * 24 * 3600 * 1000);
    const list = await listInvitations(db, viewer);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(sha256(token));
  });

  it("cannot invite as OWNER: refused by the service and by the database", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await expect(send(viewer, "a@example.com", "OWNER")).rejects.toThrow(ValidationError);
    await expect(send(viewer, "a@example.com", "SUPERUSER")).rejects.toThrow(ValidationError);
    expect(mailer.sent).toHaveLength(0);
    await expect(db.$executeRawUnsafe(`INSERT INTO "Invitation" ("id","workspaceId","emailLowercased","role","tokenHash","expiresAt") VALUES ('x','${ws.id}','o@example.com','OWNER','h',now())`)).rejects.toThrow();
  });

  it("refuses a bad address and a non-administrator", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await expect(send(viewer, "not-an-address")).rejects.toThrow(ValidationError);
    for (const role of ["MEMBER", "READER"] as const) {
      const m = await addMember(db, ws.id, `${role.toLowerCase()}@example.com`, role);
      await expect(send(await m.viewer(), "x@example.com")).rejects.toThrow(ForbiddenError);
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it("an ADMIN may invite an ADMIN, MEMBER or READER", async () => {
    const { ws } = await workspaceWithOwner(db);
    const admin = await addMember(db, ws.id, "admin@example.com", "ADMIN");
    const v = await admin.viewer();
    for (const [i, role] of (["ADMIN", "MEMBER", "READER"] as const).entries()) await send(v, `p${i}@example.com`, role);
    expect(mailer.sent).toHaveLength(3);
  });

  it("inviting an existing member is a conflict; a removed one is told to be reinstated", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const bob = await addMember(db, ws.id, "bob@example.com", "MEMBER");
    await expect(send(viewer, "bob@example.com")).rejects.toThrow(/already a member/);
    await removeMember(db, viewer, bob.member.id);
    await expect(send(viewer, "bob@example.com")).rejects.toThrow(/Reinstate/);
    expect(mailer.sent).toHaveLength(0);
  });

  it("an address that belongs to someone in ANOTHER workspace (or nobody) gets the same answer and the same mail", async () => {
    const a = await workspaceWithOwner(db, "boss@example.com", "Acme");
    const other = await workspaceWithOwner(db, "carol@example.com", "Other");
    expect(other.owner.email).toBe("carol@example.com");
    const known = await send(a.viewer, "carol@example.com");
    const unknown = await send(a.viewer, "nobody@example.com");
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[0].subject).toBe(mailer.sent[1].subject);
    expect(mailer.sent[0].text.replace(/carol|nobody|[A-Za-z0-9_-]{43}/g, "X")).toBe(mailer.sent[1].text.replace(/carol|nobody|[A-Za-z0-9_-]{43}/g, "X"));
  });

  it("re-inviting replaces the pending invitation: one pending row, the old link dies, the new role wins", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const t0 = new Date();
    await send(viewer, "dan@example.com", "READER", t0);
    const oldToken = tokenOf(mailer);
    await send(viewer, "dan@example.com", "ADMIN", new Date(t0.getTime() + 2 * INVITE_LIMITS.gapMs));
    const newToken = tokenOf(mailer);
    expect(await previewInvitation(db, oldToken)).toBeNull();
    expect(await previewInvitation(db, newToken)).toMatchObject({ role: "ADMIN", email: "dan@example.com" });
    expect(await db.invitation.count({ where: { workspaceId: ws.id, acceptedAt: null, revokedAt: null } })).toBe(1);
  });

  it("the database allows one pending invitation per address (partial unique index)", async () => {
    const { ws } = await workspaceWithOwner(db);
    const ins = (id: string, extra = "") => db.$executeRawUnsafe(`INSERT INTO "Invitation" ("id","workspaceId","emailLowercased","role","tokenHash","expiresAt"${extra ? ',"revokedAt"' : ""}) VALUES ('${id}','${ws.id}','e@example.com','MEMBER','h-${id}',now()${extra ? ",now()" : ""})`);
    await ins("one");
    await expect(ins("two")).rejects.toThrow();
    await ins("three", "revoked"); // a revoked row does not count
  });

  it("a failed delivery keeps the invitation, marks it 'email not sent', and Resend delivers it", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const failing = { send: async () => { throw new Error("smtp down"); } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createInvitation(db, viewer, { email: "eve@example.com", role: "MEMBER", mailer: failing, origin: ORIGIN });
    expect(r.mail).toBe("failed");
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("eve@example.com");
    spy.mockRestore();
    expect(await db.invitation.count({ where: { workspaceId: ws.id, acceptedAt: null, revokedAt: null } })).toBe(1);
    expect((await listInvitations(db, viewer))[0]).toMatchObject({ email: "eve@example.com", sendFailed: true });
    const again = await resendInvitation(db, viewer, r.id, { mailer, origin: ORIGIN, now: new Date(Date.now() + 2 * INVITE_LIMITS.gapMs) });
    expect(again.mail).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
    expect((await listInvitations(db, viewer))[0].sendFailed).toBe(false);
    const eve = await person(db, "eve@example.com");
    expect((await acceptInvitation(db, tokenOf(mailer), { id: eve.id, email: eve.email, emailVerifiedAt: eve.emailVerifiedAt })).ok).toBe(true);
  });

  it("a slow mail server does not hold the request: it answers 'pending' after MAIL_WAIT_MS and the send still finishes", async () => {
    const { viewer } = await workspaceWithOwner(db);
    let release!: () => void;
    const slow = { send: () => new Promise<void>((resolve) => (release = resolve)) };
    const t0 = Date.now();
    const r = await createInvitation(db, viewer, { email: "slow@example.com", role: "MEMBER", mailer: slow, origin: ORIGIN });
    expect(r.mail).toBe("pending");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MAIL_WAIT_MS - 100);
    expect(Date.now() - t0).toBeLessThan(MAIL_WAIT_MS + 3000);
    expect(await db.invitation.count({ where: { revokedAt: null } })).toBe(1); // already listed while the mail is in flight
    release();
  });
});

describe("rate limits", () => {
  it("per admin: 20 an hour, then refused with no mail", async () => {
    const { viewer } = await workspaceWithOwner(db);
    const t = new Date();
    for (let i = 0; i < INVITE_LIMITS.perAdminPerHour; i++) await send(viewer, `p${i}@example.com`, "MEMBER", t);
    await expect(send(viewer, "one-too-many@example.com", "MEMBER", t)).rejects.toThrow(ConflictError);
    expect(mailer.sent).toHaveLength(INVITE_LIMITS.perAdminPerHour);
    // an hour later the budget is back
    await send(viewer, "later@example.com", "MEMBER", new Date(t.getTime() + 61 * 60_000));
  });

  it("per workspace: a day's budget is shared by every admin", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const t = new Date();
    for (let i = 0; i < INVITE_LIMITS.perWorkspacePerDay; i++) expect(await take(db, `inv:ws:${ws.id}`, INVITE_LIMITS.perWorkspacePerDay, 24 * 3600_000, t)).toBe(true);
    await expect(send(viewer, "x@example.com", "MEMBER", t)).rejects.toThrow(/many invitations today/);
    expect(mailer.sent).toHaveLength(0);
  });

  it("per address: a second invitation within a minute is refused (and so is a resend)", async () => {
    const { viewer } = await workspaceWithOwner(db);
    const t = new Date();
    const { id } = await send(viewer, "fast@example.com", "MEMBER", t);
    await expect(send(viewer, "fast@example.com", "MEMBER", new Date(t.getTime() + 5_000))).rejects.toThrow(/just sent/);
    await expect(resendInvitation(db, viewer, id, { mailer, origin: ORIGIN, now: new Date(t.getTime() + 5_000) })).rejects.toThrow(/just sent/);
    expect(mailer.sent).toHaveLength(1);
  });
});

describe("accepting", () => {
  it("a verified user with the invited address joins with the invited role, once", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "fay@example.com", "READER");
    const token = tokenOf(mailer);
    expect(await previewInvitation(db, token)).toEqual({ workspaceName: "Acme", role: "READER", email: "fay@example.com" });
    const fay = await person(db, "fay@example.com");
    const r = await acceptInvitation(db, token, { id: fay.id, email: fay.email, emailVerifiedAt: fay.emailVerifiedAt });
    expect(r).toEqual({ ok: true, workspaceId: ws.id, already: false });
    expect(await db.member.findFirst({ where: { workspaceId: ws.id, userId: fay.id } })).toMatchObject({ role: "READER", status: "ACTIVE" });
    expect((await loadViewer(db, fay.id, ws.id))?.role).toBe("READER");
    expect(await listInvitations(db, viewer)).toHaveLength(0);
  });

  it("replay: the same link again by the same person is 'already', by anyone else invalid, and nobody is added twice", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "gus@example.com");
    const token = tokenOf(mailer);
    const gus = await person(db, "gus@example.com");
    const g = { id: gus.id, email: gus.email, emailVerifiedAt: gus.emailVerifiedAt };
    expect((await acceptInvitation(db, token, g)).ok).toBe(true);
    expect(await acceptInvitation(db, token, g)).toEqual({ ok: true, workspaceId: ws.id, already: true });
    const thief = await person(db, "thief@example.com");
    expect(await acceptInvitation(db, token, { id: thief.id, email: thief.email, emailVerifiedAt: thief.emailVerifiedAt })).toEqual({ ok: false, reason: "invalid" });
    expect(await previewInvitation(db, token)).toBeNull();
    expect(await members(ws.id)).toHaveLength(2);
  });

  it("expiry: a link is dead after 7 days, to the second", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const t0 = new Date();
    await send(viewer, "hal@example.com", "MEMBER", t0);
    const token = tokenOf(mailer);
    const hal = await person(db, "hal@example.com");
    const h = { id: hal.id, email: hal.email, emailVerifiedAt: hal.emailVerifiedAt };
    const late = new Date(t0.getTime() + INVITE_TTL_MS);
    expect(await previewInvitation(db, token, late)).toBeNull();
    expect(await acceptInvitation(db, token, h, late)).toEqual({ ok: false, reason: "invalid" });
    expect(await previewInvitation(db, token, new Date(late.getTime() - 1000))).not.toBeNull();
    expect(await members(ws.id)).toHaveLength(1);
  });

  it("revocation: a withdrawn link is dead", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const { id } = await send(viewer, "ivy@example.com");
    const token = tokenOf(mailer);
    await revokeInvitation(db, viewer, id);
    const ivy = await person(db, "ivy@example.com");
    expect(await acceptInvitation(db, token, { id: ivy.id, email: ivy.email, emailVerifiedAt: ivy.emailVerifiedAt })).toEqual({ ok: false, reason: "invalid" });
    await expect(revokeInvitation(db, viewer, id)).rejects.toThrow(NotFoundError);
    expect(await members(ws.id)).toHaveLength(1);
  });

  it("wrong email: a signed-in user with another address does not join, and the invitation stays usable", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "jan@example.com");
    const token = tokenOf(mailer);
    const other = await person(db, "other@example.com");
    expect(await acceptInvitation(db, token, { id: other.id, email: other.email, emailVerifiedAt: other.emailVerifiedAt })).toEqual({ ok: false, reason: "wrong-email" });
    // an unverified address (typed in, never proven) does not count even when it matches
    const typed = await db.user.create({ data: { login: "typed", email: "jan@example.com" } });
    expect(await acceptInvitation(db, token, { id: typed.id, email: typed.email, emailVerifiedAt: null })).toEqual({ ok: false, reason: "wrong-email" });
    // a GitHub-only user (no email) cannot prove it either
    const gh = await db.user.create({ data: { login: "ghonly", githubId: 99n } });
    expect(await acceptInvitation(db, token, { id: gh.id, email: null, emailVerifiedAt: null })).toEqual({ ok: false, reason: "wrong-email" });
    expect(await members(ws.id)).toHaveLength(1);
    expect(await previewInvitation(db, token)).not.toBeNull();
  });

  it("concurrent accepts make exactly one membership", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "kim@example.com", "MEMBER");
    const token = tokenOf(mailer);
    const kim = await person(db, "kim@example.com");
    const k = { id: kim.id, email: kim.email, emailVerifiedAt: kim.emailVerifiedAt };
    const results = await Promise.all(Array.from({ length: 8 }, () => acceptInvitation(db, token, k)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.already)).toHaveLength(1);
    expect(await db.member.count({ where: { workspaceId: ws.id, userId: kim.id } })).toBe(1);
    expect(await db.invitation.count({ where: { workspaceId: ws.id, acceptedAt: { not: null } } })).toBe(1);
  });

  it("a member removed after the invitation went out is not re-admitted by it", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "lee@example.com", "MEMBER");
    const token = tokenOf(mailer);
    const lee = await addMember(db, ws.id, "lee@example.com", "MEMBER");
    await db.member.update({ where: { id: lee.member.id, workspaceId: ws.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect(await acceptInvitation(db, token, await asUser("lee@example.com"))).toEqual({ ok: false, reason: "invalid" });
    expect(await db.member.findUniqueOrThrow({ where: { id: lee.member.id } })).toMatchObject({ status: "REVOKED" });
    expect(await previewInvitation(db, token)).not.toBeNull(); // the claim rolled back
  });

  it("a user who is already ACTIVE keeps their role; the invitation does not promote or demote them", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "mia@example.com", "ADMIN");
    const token = tokenOf(mailer);
    const mia = await addMember(db, ws.id, "mia@example.com", "READER");
    const r = await acceptInvitation(db, token, await asUser("mia@example.com"));
    expect(r).toMatchObject({ ok: true, already: true });
    expect((await mia.viewer()).role).toBe("READER");
  });

  it("an existing GitHub-linked user joins by email like anyone else", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "octo@example.com", "MEMBER");
    const gh = await person(db, "octo@example.com", { githubId: 4242n });
    const r = await acceptInvitation(db, tokenOf(mailer), { id: gh.id, email: gh.email, emailVerifiedAt: gh.emailVerifiedAt });
    expect(r.ok).toBe(true);
    expect((await loadViewer(db, gh.id, ws.id))?.githubId).toBe(4242n);
  });

  it("malformed tokens are invalid, not errors", async () => {
    const u = await person(db, "x@example.com");
    for (const t of [undefined, null, 5, "", "short", "x".repeat(500)]) {
      expect(await previewInvitation(db, t)).toBeNull();
      expect(await acceptInvitation(db, t, { id: u.id, email: u.email, emailVerifiedAt: u.emailVerifiedAt })).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("sign-in, then accept", () => {
  it("opening the invitation does not join anyone, and signing in alone does not either; the magic link to the invited address proves it", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "new@example.com", "MEMBER");
    const inviteToken = tokenOf(mailer);
    expect(await db.user.findUnique({ where: { email: "new@example.com" } })).toBeNull(); // nobody was created by being invited
    expect(await previewInvitation(db, inviteToken)).not.toBeNull(); // looking changes nothing
    expect(await members(ws.id)).toHaveLength(1);

    const login = new RecordingMailer();
    expect(await requestMagicLink(db, { email: "new@example.com", origin: ORIGIN, mailer: login, browserNonce: NONCE, next: `/invite/${inviteToken}` })).toBe("sent");
    expect(login.link()).toContain(`next=${encodeURIComponent(`/invite/${inviteToken}`)}`);
    const consumed = await consumeMagicLink(db, new URL(login.link()).searchParams.get("token"), NONCE);
    if (!consumed.ok) throw new Error("link not consumed");
    expect(await members(ws.id)).toHaveLength(1); // signed in, still not a member

    const user = await db.user.findUniqueOrThrow({ where: { id: consumed.userId } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await acceptInvitation(db, inviteToken, { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt })).toMatchObject({ ok: true, workspaceId: ws.id });
    expect((await loadViewer(db, user.id, ws.id))?.role).toBe("MEMBER");
  });

  it("an unverified OIDC-style account that merely holds the address cannot accept", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    await send(viewer, "claim@example.com", "ADMIN");
    const squatter = await db.user.create({ data: { login: "squatter", email: "claim@example.com" } }); // typed in, never verified
    expect(await acceptInvitation(db, tokenOf(mailer), { id: squatter.id, email: squatter.email, emailVerifiedAt: squatter.emailVerifiedAt })).toEqual({ ok: false, reason: "wrong-email" });
    expect(await members(ws.id)).toHaveLength(1);
  });
});

describe("resend and withdraw", () => {
  it("resend issues a new token; the old one stops working", async () => {
    const { viewer, ws } = await workspaceWithOwner(db);
    const t0 = new Date();
    const { id } = await send(viewer, "ned@example.com", "MEMBER", t0);
    const oldToken = tokenOf(mailer);
    await resendInvitation(db, viewer, id, { mailer, origin: ORIGIN, now: new Date(t0.getTime() + 2 * INVITE_LIMITS.gapMs) });
    const newToken = tokenOf(mailer);
    expect(newToken).not.toBe(oldToken);
    const ned = await person(db, "ned@example.com");
    const n = { id: ned.id, email: ned.email, emailVerifiedAt: ned.emailVerifiedAt };
    expect(await acceptInvitation(db, oldToken, n)).toEqual({ ok: false, reason: "invalid" });
    expect((await acceptInvitation(db, newToken, n)).ok).toBe(true);
    expect(await db.invitation.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it("another workspace's invitation id is simply not found", async () => {
    const a = await workspaceWithOwner(db, "a@example.com", "A");
    const b = await workspaceWithOwner(db, "b@example.com", "B");
    const { id } = await send(a.viewer, "zed@example.com");
    await expect(revokeInvitation(db, b.viewer, id)).rejects.toThrow(NotFoundError);
    await expect(resendInvitation(db, b.viewer, id, { mailer, origin: ORIGIN })).rejects.toThrow(NotFoundError);
    expect(await listInvitations(db, b.viewer)).toHaveLength(0);
  });
});
