/**
 * The workspace role policy as pure functions and one table. No database, no framework: docs/roles.md prints this table, and
 * tests/roles-policy.test.ts walks every role against every action.
 *
 * OWNER > ADMIN > MEMBER > READER. A workspace has exactly one OWNER (partial unique index, and the member services never remove,
 * demote or let the owner leave). Role strings that are not one of the four (legacy rows, tampered input) match nothing.
 */
export const ROLES = ["OWNER", "ADMIN", "MEMBER", "READER"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = ["read", "write", "manageMembers", "manageSpaces", "manageGithub", "changeRoles", "transferOwnership", "deleteWorkspace", "leaveWorkspace"] as const;
export type Action = (typeof ACTIONS)[number];

/** Who is asking. A viewer without `status` is taken as ACTIVE (Viewer objects only exist for active members). */
export type Subject = { role: Role | string; status?: "ACTIVE" | "REVOKED" | string };

/**
 * What the action is about. Every field is optional; the more is given, the more the policy checks.
 *  - targetRole / newRole: the member being managed and the role they would get (changeRoles, manageMembers, transferOwnership).
 *  - targetActive: whether that member is ACTIVE (transferOwnership needs an ACTIVE ADMIN).
 *  - spaceCanWrite: the viewer's own write flag in the space the write happens in (undefined = the COMMON space, no restriction).
 */
export type Resource = { targetRole?: Role | string; newRole?: Role | string; targetActive?: boolean; spaceCanWrite?: boolean };

type Rule = boolean | ((r: Resource) => boolean);

const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);
/** The owner is never the target of an ordinary management action and never the result of a role change. */
const notOwner = (r: Resource) => r.targetRole !== "OWNER" && r.newRole !== "OWNER";

/**
 * POLICY[action][role]. A function rule decides from the resource; `true` is unconditional.
 *  - READER reads and may leave; nothing else.
 *  - MEMBER writes where the space allows it.
 *  - ADMIN manages members (READER, MEMBER, ADMIN, never the OWNER, never to OWNER), spaces and the GitHub connection (manageGithub). ADMIN writes like MEMBER.
 *  - OWNER does all of that plus transferring ownership (to an ACTIVE ADMIN) and deleting the workspace. The OWNER cannot leave.
 */
export const POLICY: Record<Action, Record<Role, Rule>> = {
  read: { OWNER: true, ADMIN: true, MEMBER: true, READER: true },
  write: {
    OWNER: (r) => r.spaceCanWrite !== false,
    ADMIN: (r) => r.spaceCanWrite !== false,
    MEMBER: (r) => r.spaceCanWrite !== false,
    READER: false,
  },
  manageMembers: { OWNER: notOwner, ADMIN: notOwner, MEMBER: false, READER: false },
  manageSpaces: { OWNER: true, ADMIN: true, MEMBER: false, READER: false },
  manageGithub: { OWNER: true, ADMIN: true, MEMBER: false, READER: false },
  changeRoles: { OWNER: notOwner, ADMIN: notOwner, MEMBER: false, READER: false },
  transferOwnership: {
    OWNER: (r) => (r.targetRole === undefined && r.targetActive === undefined) || (r.targetRole === "ADMIN" && r.targetActive === true),
    ADMIN: false,
    MEMBER: false,
    READER: false,
  },
  deleteWorkspace: { OWNER: true, ADMIN: false, MEMBER: false, READER: false },
  leaveWorkspace: { OWNER: false, ADMIN: true, MEMBER: true, READER: true },
};

/** True when the subject may do `action` on `resource`. Unknown roles, unknown actions and REVOKED members get false. */
export function can(subject: Subject, action: Action, resource: Resource = {}): boolean {
  if (subject.status !== undefined && subject.status !== "ACTIVE") return false;
  if (!isRole(subject.role)) return false;
  const row = POLICY[action] as Record<Role, Rule> | undefined;
  if (!row) return false;
  const rule = row[subject.role];
  return typeof rule === "function" ? rule(resource) : rule;
}

/** The roles an inviter or role-changer may hand out: everything except OWNER (ownership moves only by transfer). */
export const ASSIGNABLE_ROLES = ["ADMIN", "MEMBER", "READER"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export const isAssignableRole = (r: unknown): r is AssignableRole => typeof r === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(r);

/** Roles that administer the workspace (what the older `isAdmin` flag meant). */
export const isAdminRole = (r: unknown): boolean => r === "OWNER" || r === "ADMIN";

/** Display labels, shared by the members page and the invitation mail. */
export const ROLE_LABEL: Record<Role, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", READER: "Reader" };
