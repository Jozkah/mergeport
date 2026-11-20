import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, POLICY, can, isAssignableRole, type Action, type Resource, type Role } from "@/lib/authz/roles";
import { ForbiddenError } from "@/lib/errors";
import { requireWrite, subjectOf } from "@/lib/authz/viewer";

/** The expected answer for every role and action with no resource given. Written out on purpose: it must not be derived from POLICY. */
const EXPECT: Record<Action, Record<Role, boolean>> = {
  read: { OWNER: true, ADMIN: true, MEMBER: true, READER: true },
  write: { OWNER: true, ADMIN: true, MEMBER: true, READER: false },
  manageMembers: { OWNER: true, ADMIN: true, MEMBER: false, READER: false },
  manageSpaces: { OWNER: true, ADMIN: true, MEMBER: false, READER: false },
  changeRoles: { OWNER: true, ADMIN: true, MEMBER: false, READER: false },
  transferOwnership: { OWNER: true, ADMIN: false, MEMBER: false, READER: false },
  deleteWorkspace: { OWNER: true, ADMIN: false, MEMBER: false, READER: false },
  leaveWorkspace: { OWNER: false, ADMIN: true, MEMBER: true, READER: true },
};

describe("role policy: every role against every action", () => {
  it("covers all four roles and every action", () => {
    expect([...ROLES]).toEqual(["OWNER", "ADMIN", "MEMBER", "READER"]);
    expect(Object.keys(EXPECT).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(POLICY).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    for (const role of ROLES) {
      it(`${role} ${EXPECT[action][role] ? "may" : "may not"} ${action}`, () => {
        expect(can({ role }, action)).toBe(EXPECT[action][role]);
      });
    }
  }

  it("a REVOKED member, an unknown role and an unknown action get nothing", () => {
    for (const a of ACTIONS) {
      expect(can({ role: "OWNER", status: "REVOKED" }, a)).toBe(false);
      expect(can({ role: "SUPERUSER" }, a)).toBe(false);
      expect(can({ role: "" }, a)).toBe(false);
    }
    expect(can({ role: "OWNER" }, "formatDisk" as Action)).toBe(false);
  });
});

describe("role policy: resource rules", () => {
  const cases: { name: string; role: Role; action: Action; res: Resource; ok: boolean }[] = [
    { name: "ADMIN cannot manage the OWNER", role: "ADMIN", action: "manageMembers", res: { targetRole: "OWNER" }, ok: false },
    { name: "the OWNER cannot be managed by the owner either (transfer instead)", role: "OWNER", action: "manageMembers", res: { targetRole: "OWNER" }, ok: false },
    { name: "ADMIN manages another ADMIN", role: "ADMIN", action: "manageMembers", res: { targetRole: "ADMIN" }, ok: true },
    { name: "ADMIN manages a READER", role: "ADMIN", action: "manageMembers", res: { targetRole: "READER" }, ok: true },
    { name: "ADMIN cannot promote to OWNER", role: "ADMIN", action: "changeRoles", res: { targetRole: "MEMBER", newRole: "OWNER" }, ok: false },
    { name: "OWNER cannot promote to OWNER by changing a role", role: "OWNER", action: "changeRoles", res: { targetRole: "ADMIN", newRole: "OWNER" }, ok: false },
    { name: "ADMIN cannot change the OWNER's role", role: "ADMIN", action: "changeRoles", res: { targetRole: "OWNER", newRole: "MEMBER" }, ok: false },
    { name: "ADMIN promotes MEMBER to ADMIN", role: "ADMIN", action: "changeRoles", res: { targetRole: "MEMBER", newRole: "ADMIN" }, ok: true },
    { name: "ADMIN demotes ADMIN to READER", role: "ADMIN", action: "changeRoles", res: { targetRole: "ADMIN", newRole: "READER" }, ok: true },
    { name: "an invitation as OWNER is not a manage action", role: "OWNER", action: "manageMembers", res: { newRole: "OWNER" }, ok: false },
    { name: "OWNER transfers to an ACTIVE ADMIN", role: "OWNER", action: "transferOwnership", res: { targetRole: "ADMIN", targetActive: true }, ok: true },
    { name: "OWNER cannot transfer to a MEMBER", role: "OWNER", action: "transferOwnership", res: { targetRole: "MEMBER", targetActive: true }, ok: false },
    { name: "OWNER cannot transfer to a removed ADMIN", role: "OWNER", action: "transferOwnership", res: { targetRole: "ADMIN", targetActive: false }, ok: false },
    { name: "ADMIN cannot transfer ownership", role: "ADMIN", action: "transferOwnership", res: { targetRole: "ADMIN", targetActive: true }, ok: false },
    { name: "MEMBER writes where the space allows it", role: "MEMBER", action: "write", res: { spaceCanWrite: true }, ok: true },
    { name: "MEMBER cannot write where the space is read-only for them", role: "MEMBER", action: "write", res: { spaceCanWrite: false }, ok: false },
    { name: "ADMIN is held to the space's write flag too", role: "ADMIN", action: "write", res: { spaceCanWrite: false }, ok: false },
    { name: "READER cannot write even with the space flag set (role floor)", role: "READER", action: "write", res: { spaceCanWrite: true }, ok: false },
  ];
  for (const c of cases) it(c.name, () => expect(can({ role: c.role }, c.action, c.res)).toBe(c.ok));
});

describe("helpers", () => {
  it("OWNER is never an assignable role", () => {
    expect(isAssignableRole("OWNER")).toBe(false);
    expect(["ADMIN", "MEMBER", "READER"].every(isAssignableRole)).toBe(true);
    expect(isAssignableRole("owner")).toBe(false);
  });

  it("requireWrite stops a READER and a member without space write access, and lets writers through", () => {
    expect(() => requireWrite({ role: "READER", isAdmin: false })).toThrow(ForbiddenError);
    expect(() => requireWrite({ role: "MEMBER", isAdmin: false }, false)).toThrow(/read-only access to this space/);
    expect(() => requireWrite({ role: "MEMBER", isAdmin: false })).not.toThrow();
    expect(() => requireWrite({ role: "OWNER", isAdmin: true })).not.toThrow();
  });

  it("a hand-built viewer without a role counts by isAdmin (older callers)", () => {
    expect(subjectOf({ isAdmin: true })).toEqual({ role: "ADMIN" });
    expect(subjectOf({ isAdmin: false })).toEqual({ role: "MEMBER" });
    expect(subjectOf({ role: "READER", isAdmin: false })).toEqual({ role: "READER" });
  });
});
