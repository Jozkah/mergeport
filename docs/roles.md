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
| connect and disconnect the GitHub App installation (`manageGithub`) | yes | yes | no | no |
| transfer ownership (to an ACTIVE ADMIN) | yes | no | no | no |
| delete the workspace (policy only; no UI yet) | yes | no | no | no |
| leave the workspace | no (transfer first) | yes | yes | yes |

An ADMIN may demote or remove another ADMIN (the owner is the safety net); only the owner moves ownership. A REVOKED member, an unknown
role string or an unknown action gets nothing.

## Where it is enforced

- `Viewer.role` is read from the `Member` row on every request (`loadViewer`); `isAdmin` is OWNER or ADMIN, kept for existing checks.
- `requireAdmin`, `requireRepo(..., "manageWork" | "review")`, `capabilitiesFor`, `assertProjectWritable` and `requireProjectWrite` keep their
  signatures and now go through `can()`. A READER fails every repository write capability even with grant flags set.
- **Repository visibility (`repoWhere`)** is one rule, and Mergeport (not GitHub's token) decides it. A hosted GitHub App installation token
  reads every repository the installation can access, so private code is protected here.
  **Old rule** (before the per-person GitHub link): OWNER and ADMIN see every tracked repository of the workspace; a MEMBER or READER sees a
  repository only through an explicit, unrevoked `RepositoryGrant`.
  **New rule:** OWNER and ADMIN are unchanged (every tracked repository of the workspace). A MEMBER or READER sees a repository through
  EITHER of two additive routes: (1) an explicit, unrevoked `RepositoryGrant` (as before; it is how people without a GitHub link get
  access, and admins grant it with an audit row); or (2) **GitHub says they may read it**: the repository is tracked through an installation
  (`Repository.installationId` not null) AND the viewer has a `GithubRepoAccess` row for its GitHub id, obtained through that same
  installation, with permission `pull`, `triage`, `push`, `maintain` or `admin`, whose `checkedAt` is at most **30 minutes** old
  (`VALID_FOR_MS`). `loadViewer` loads that list once per request into `Viewer.githubRepoIds` (capped at 5000, joined to this workspace's own
  repositories so a row obtained through another workspace's installation counts for nothing here), and `repoWhere` adds
  `{ githubId: { in: ids }, installationId: { not: null } }` under `AND: [{ OR: [grant, that] }]`. A repository that is public is not visible
  by that fact alone: it appears for a member only if GitHub lists it for them (GitHub does report `pull` on a public repository of an
  installation) or they hold a grant. Untracked (REMOVED) repositories are visible to nobody.
  **Route 2 is read access.** Changing things (`requireRepo(..., "manageWork" | "review")`, `capabilitiesFor`) still needs a grant and a
  role that writes: a person who can see a repository only through GitHub gets a clear refusal ("no grant to change it"), and a READER
  never writes. **Fail closed:** a stale row, no row, no GitHub link, a link that needs renewing, a missing encryption key or a refresh that
  has not run yet all mean "no GitHub-derived access", never "keep the last answer".
  **Revocation lag:** when access is removed on GitHub, the person keeps seeing the repository until the next refresh of their data
  lands (the scheduler and page loads ask every 10 minutes; "Check again" asks at once) and, at the latest, until their last good check is 30
  minutes old. The lag is therefore bounded by `VALID_FOR_MS` plus the time to run the job. Webhooks that shorten it arrive in a later task.
  Lists, counts, search, queues, inbox, digest, AI context, notifications, activity, planning, the federation read API, the CLI and every id route
  (page or API: a hidden item is "not found", never "forbidden") all go through `repoWhere` / `viaRepo` / `requireRepo`;
  `tests/github-hosted-visibility.test.ts` (grants) and `tests/github-access.test.ts` (GitHub-verified access) walk them. Tracking a repository
  from an installation is an administrator action and grants nobody anything. The disjunction sits under `AND`, so a caller that spreads
  `repoWhere` and adds its own `OR` cannot replace it; a test fails on any spread followed by `AND`.
- **Tracking and untracking are administrator actions when hosted** (`importPublicAction`, `untrackRepositoryAction`, `trackLocally`,
  `removeFromTracking`): a member can neither give themselves a grant by importing a public URL nor revoke everyone's by untracking. Hosted
  `trackLocally` never creates or revives a grant and never re-activates an untracked repository. When sync sees a PUBLIC repository
  turn private, every unrevoked grant on it is revoked and an audit row `repository.visibility-flip` is written. Stored daily digests of
  the people who lose access are deleted (`purgeDigests`) on a revoked grant, an untracked repository, a removed member and that flip,
  so a snapshot never outlives the access it was made from.
- **Capabilities.** `requireRepo` / `requireWorkItem` take `"read"` (the default and the only read), `"manageWork"` or `"review"`; there is no
  capability that is both a read and usable for a change. Every action that queues a sync, shares or unshares a repository, maps a fork,
  untracks, or records a backport check names `"manageWork"` (so a person who sees a repository only through GitHub is refused with "no grant to
  change it"); reads, personal local-clone helpers (`mapLocalRoot`, `scanWorktrees`, `worktreesFor`), the upstream side of a fork action
  and the visibility context of a review draft or manual waiting record use `"read"`.
- **Stored digests are served only while they still match what the person can see.** Each digest carries a fingerprint of the repositories
  the person could see when it was made (`DailyDigest.visibilityKey`); `getDigest` and `latestDigest` drop a digest whose fingerprint differs
  from the current `repoWhere` result (either direction), and a digest without a fingerprint is never served. So a relink, an expired access
  window, a failed refresh or a revoked grant cannot leave an old digest on screen, whether or not a purge ran. Relinking, unlinking,
  removal and a refresh that removes access also delete the rows. Notifications are filtered by `repoWhere` at read time and saved filters
  hold query text only, so neither keeps repository content after access is lost.
- **GitHub people are matched by numeric id, the login is only a fallback.** Sync stores GitHub's numeric user id next to every login it
  records: `ReviewRequest.reviewerGithubId` (requested reviewers), `WorkItem.assigneeIds` (an index like the login one), `WorkItem.authorGithubId`
  and `WorkItemComment.authorGithubId` (review and comment authors). Review queues, the inbox, the digest, review-request and
  changes-requested notifications and AI context compare the viewer's `User.githubId` with those ids (`src/lib/domain/identity.ts`): a person
  who renamed their GitHub login keeps their queue, and someone who later takes a released login does not inherit it. A request follows a
  rename in place (same row, same wait time). Only where one side has no id does the login decide: older rows stored before ids were
  recorded (they gain ids the next time the item is synced after it changes), local and demo items, a person without a stored id, and
  items where GitHub gave an id for only some assignees. A migration adds the columns as nullable or empty, so nothing needs a backfill.
  What still compares logins: routing and waiting rules and manual waiting records (an administrator types a login), team membership
  lists, and the free-text assignee and author filters. In addition `Viewer.githubLogin` (and with it the id) is null unless the link is
  working and was confirmed with GitHub within 24 hours, and is cleared when the link needs renewing and on unlink.
- **Known limitation:** `runDailyDigest` generates a workspace's digest only for its oldest member (unchanged behaviour); other members get
  theirs when they open the page and regenerate.
- **GitHub identity is not the sign-in name.** `Viewer.githubLogin` is the person's GitHub login, or null without a linked GitHub account
  (`login` is the mailbox local part for an email user). It comes from the link (`User.githubLogin`, set when the person links GitHub
  and refreshed whenever their GitHub token is used); only a legacy local user whose `githubId` came from `gh` and has no stored login falls
  back to `login`. Review queues, the inbox, the digest, review-request notifications and AI context match GitHub data on the GitHub identity (`githubId`, `githubLogin`)
  only, so an email user named "alice" never inherits the GitHub user "alice"'s reviews. People without a linked account see "Personal review
  queues need a linked GitHub account" with a **Link GitHub** button on My attention and Inbox (where linking exists), and a
  "GitHub account" panel on Settings (docs/github-app.md, "Linking your GitHub account").
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
  AccessSpaceMember rows deleted, repository grants revoked, the stored digests and the cached GitHub access that came through this
  workspace's installations deleted (kept where another workspace the person still belongs to uses the same installation), and every session of that person bound to this workspace gets
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

## AI apps

A personal access token for the hosted MCP endpoint acts as its owner with the owner's role, checked on every call; a READER can only hold a read-only token and can never write through it. See docs/mcp.md.
