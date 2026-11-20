# Roles, members and spaces

Hosted workspaces have four roles and one owner. The policy is one table in `src/lib/authz/roles.ts` (`POLICY`, `can(subject, action, resource)`);
`tests/roles-policy.test.ts` checks every role against every action. Ported from `hub/src/authz.ts` and `hub/src/admin-routes.ts`
(the hub is not imported and not changed).

## Roles

OWNER > ADMIN > MEMBER > READER. A workspace has **exactly one OWNER**: the person who created it in `/onboarding`. The database allows at
most one (`Member_one_owner`, a partial unique index) and the services never remove, demote or let the owner leave, so there is
always one. Existing workspaces were migrated by `20261121100000_roles_invitations_spaces`: the oldest ADMIN of each (ties by id)
became OWNER; a workspace with no ACTIVE ADMIN gives it to its oldest ACTIVE member; a removed (REVOKED) member is never made OWNER; old MEMBER and ADMIN rows kept their role. A workspace with no ACTIVE member at all gets no OWNER: nobody can sign in to it, so nobody can invite or transfer, and an operator promotes one row by hand (`UPDATE "Member" SET role='OWNER', status='ACTIVE' WHERE id=...`; the unique index allows exactly one).

| Action | OWNER | ADMIN | MEMBER | READER |
| --- | --- | --- | --- | --- |
| read (everything the space and repository grants let them see) | yes | yes | yes | yes |
| write (create and change work) | yes | yes | yes | **no** |
| write in a restricted space | needs `canWrite` | needs `canWrite` | needs `canWrite` | never |
| invite, remove, reinstate members; change roles (READER / MEMBER / ADMIN) | yes | yes | no | no |
| touch the OWNER (remove, demote, change role) | no | no | no | no |
| hand out OWNER (invite as OWNER, role change to OWNER) | no | no | no | no |
| create and delete spaces, edit space membership, move projects between spaces | yes | yes | no | no |
| transfer ownership (to an ACTIVE ADMIN) | yes | no | no | no |
| delete the workspace (policy only; no UI yet) | yes | no | no | no |
| leave the workspace | no (transfer first) | yes | yes | yes |

An ADMIN may demote or remove another ADMIN (the owner is the safety net); only the owner moves ownership. A REVOKED member, an unknown
role string or an unknown action gets nothing.

## Where it is enforced

- `Viewer.role` is read from the `Member` row on every request (`loadViewer`); `isAdmin` is OWNER or ADMIN, kept for existing checks.
- `requireAdmin`, `requireRepo(..., "manageWork" | "review")`, `capabilitiesFor`, `assertProjectWritable` and `requireProjectWrite` keep their
  signatures and now go through `can()`. A READER fails every repository write capability even with grant flags set.
- **Mutating server actions** start with `requireWriter()` (signed in, role may write) or `requireAdminViewer()`. Actions that only
  change the caller's own preferences (timezone, notification and digest settings, inbox state, saved filters, working scope) use
  `requireViewer()` and are listed with a reason in `tests/mutation-guard.test.ts`, which also fails on any exported action in a
  `"use server"` file that has neither a guard nor an entry there. The POST route `api/ai/draft` calls `requireWrite`; backup restore is
  administrator-only in its service.
- Member services (`services/members.ts`, `invitations.ts`, `access-spaces.ts`) re-read the acting member inside the transaction
  and look every target up by (id, workspaceId): a stale viewer cannot use powers it lost, and another workspace's id is "not found".

## Members

Settings > Members (`/settings/members`). Administrators see everyone (active, then removed), pending invitations and the invite form;
everyone sees their own role and Leave.

- **Invite** by email with a role (never OWNER): `docs/auth.md`. Existing members and removed members cannot be invited (reinstate the latter).
- **Change role**: ADMIN or OWNER, between READER / MEMBER / ADMIN, never the owner's role. "A workspace needs at least one
  administrator" is also checked, though the owner always satisfies it.
- **Remove**: status REVOKED (the row stays for authorship and audit), `revokedAt` set, and in one transaction: ProjectMember and
  AccessSpaceMember rows deleted, repository grants revoked, and every session of that person bound to this workspace gets
  `activeWorkspaceId = NULL`. Access ends on the next request because `loadViewer` and `resolveActiveWorkspaceId` need an ACTIVE row.
  Their other workspaces are untouched.
- **Reinstate**: back to ACTIVE with a role chosen now (not OWNER). Project and space memberships are not restored.
- **Leave**: anyone but the owner; same effect as a removal.
- **Transfer ownership**: the owner picks an ACTIVE ADMIN. One transaction, two guarded updates (the owner becomes ADMIN, then the target
  becomes OWNER, each naming the role it expects); two simultaneous transfers cannot both win, and the partial unique index backs it.

## Spaces as access lists

`AccessSpace` (not the GitHub/hub sync `Space`, which is scheduled for removal and untouched): kind COMMON or RESTRICTED, and
`AccessSpaceMember(spaceId, memberId, canWrite)`. Every workspace gets one COMMON space on creation (a partial unique index keeps it one;
the migration created them for old workspaces; `ensureCommonSpace` repairs a missing one). A project lives in one space
(`Project.accessSpaceId`, null means COMMON).

- COMMON: every active member reads; MEMBER and above write; READER does not.
- RESTRICTED: only listed members read, and write only with `canWrite` **and** a role of MEMBER or above (the role floor wins, as in the hub).
  **Administrators and the owner are not exempt**: outside the list they see nothing inside. They can add themselves from the Spaces
  panel (an admin sees every space's membership list, not its projects).
- Enforced where projects are queried: `projectWhere` and `planningWhere` apply `accessSpaceWhere`, so project lists, the scope switcher,
  tasks and task counts, cards, boards, roadmap, search, getting-started and the CLI listing all hide a restricted project from
  non-members, and writes go through `assertProjectWritable`, which also applies the space's `canWrite`. `tests/spaces-acl.test.ts` exercises them.
- A restricted space that still holds projects cannot be deleted, and moving a project to the common space is an explicit administrator action
  (the panel warns that everyone then sees it). The common space cannot be deleted and has no member list.

## Not done

Workspace deletion UI, per-repository access through spaces (repositories still use grants), SSO/SAML, GitHub-based roles, and changing
the OWNER's email. The sync `Space` (GitHub/hub) is unrelated and still scheduled for deletion.
