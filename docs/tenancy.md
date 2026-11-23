# Tenancy

Mergeport runs many workspaces in one Postgres. A workspace is the tenant. Every row a tenant owns is reachable only through
that workspace, and every query on tenant data names the workspace.

## Model classification

86 models: 1 tenant anchor, 35 ROOT, 38 CHILD, 12 GLOBAL.

**Tenant anchor.** `Workspace` is the tenant itself.

**ROOT (35).** The model has a `workspaceId` column, a foreign key to `Workspace` with `ON DELETE CASCADE`, and an index that
starts with it (a unique key that starts with it counts). Every query on a ROOT model must name the workspace.

| Model | Notes |
| --- | --- |
| Member, Repository, Project | Repository is unique on (workspaceId, githubId). Project is unique on (workspaceId, slug). Member carries the role (OWNER, ADMIN, MEMBER, READER; at most one OWNER per workspace, a partial unique index); Project carries `accessSpaceId`. |
| Invitation, AccessSpace | Email invitations (docs/auth.md) and the space ACL (docs/roles.md). One COMMON AccessSpace per workspace (partial unique index). `AccessSpaceMember` (CHILD, through AccessSpace) lists who is in a RESTRICTED one. Not the sync `Space`. |
| ReviewRule, WaitingRule, WaitingRecord | WaitingRecord, ReviewerAvailability, LabelMap and UpstreamSubscription had the column but no foreign key; the migration adds it. |
| DashboardMilestone, ReviewerAvailability, LabelMap, UpstreamSubscription | |
| Notification, AuditLog, DailyDigest | DailyDigest is unique on (workspaceId, userId, day): a person in two workspaces gets one digest per workspace. |
| Space | Unique on (workspaceId, backend, repoOwner, repoName, hubSpaceId): two workspaces may join the same coordination repository. |
| TeamConfig, HubSession, AiSettings | Were fixed-id singletons (`team`, `session`, `ai`). Now one row per workspace: `workspaceId` is unique, the id is a cuid. |
| AiSuggestion, AiPendingAction | |
| FederationPolicy, FederationLink, FederationGrant, FederationCache, FederationEvent | Linking instances (docs/federation.md). Policy is unique on `workspaceId`. A link and its cache are the linking person's only: every query names workspace, person and link. A grant is found by the sha256 of its code or token (the secret names the tenant; allowlisted `findUnique` lookups, like the callback's lookup of a pending link by its state and the signed-in person) and everything after that uses `grant.workspaceId`. The cache is never read by search, digests, AI or backup (a test greps for it). |
| GitCache, DiscoveryCache | Primary key is (workspaceId, key). The git cache holds private repository content, and discovery lists come from one person's credential, so neither may be shared across tenants. |
| WorkspaceInstallation | Which GitHub App installations a workspace uses (docs/github-app.md). Unique on (workspaceId, installationId). This row is the tenant record: access to an installation, and so to its repositories, exists only through it. A row exists only once control was proved: `verifiedAt`, `verifiedGithubUserId` (the GitHub user whose token proved it) and `proofMethod` (for example `user-installations`) are NOT NULL, and `connectedByUserId` (SET NULL) records who in Mergeport connected it. `Repository.installationId` (nullable, indexed) names the installation that serves a repository; local `gh` and demo repositories stay null. It is tied to the bindings by a composite foreign key `Repository (workspaceId, installationId)` to `WorkspaceInstallation (workspaceId, installationId)` (MATCH SIMPLE, so null is unchecked; NO ACTION, checked at the end of the statement so deleting a workspace still cascades through both tables). A binding cannot be deleted while a repository uses it: `unbindInstallation` nulls the repositories first. Only `src/lib/github/binding.ts` writes the column and creates or removes bindings (`bindInstallation`, `unbindInstallation`; the connect flow in `src/lib/github/connect.ts` calls them after proof; `tests/github-app-bindings.test.ts` scans for the column writes), and the sync entity upserts never touch it. The same installation may be bound by several workspaces, each with its own proof row. |
| GithubAppState | Short-lived, single-use install and OAuth state (hash only, user, kind, expiry, used time), issued to one user for one workspace: workspaceId with a cascading foreign key and an index that starts with it. The state value is `<workspaceId>.<random>`; the callback reads the workspace id from the front (untrusted), hashes the whole value and claims it with `claimAppState` (one conditional UPDATE on workspace, hash, `usedAt` null and `expiresAt` in the future, count must be 1), so concurrent callbacks have one winner and an expired or used state claims nothing. The connect flow issues kinds `connect` and `connect-existing[:account]`, bound to the starting person; the callback also requires the same signed-in person, the browser nonce cookie (`nonceHash`) and an ACTIVE membership with the `manageGithub` right in that workspace. |
| ApiToken | Personal access token for the hosted MCP endpoint (docs/mcp.md): bound to one workspace and one user, only the sha256 of the secret stored (`tokenHash`, unique). Found by that hash (an allowlisted `findUnique`: the secret names the tenant); the row then supplies the workspace for `loadViewer` and everything after. |
| OAuthGrant, OAuthCode, OAuthRefresh | OAuth for the hosted MCP endpoint (docs/mcp.md): a grant is one person's consent for one app in ONE workspace (the family its tokens hang off); a code is single-use, 60 seconds, bound to client, redirect address, PKCE challenge, workspace and person; a refresh token rotates on every use. Codes and refresh tokens are found by the sha256 of their secret (allowlisted `findUnique`); the row then supplies the workspace for every later query, including the single-use claim. `ApiToken` also carries `kind` (PAT or OAUTH), `grantId` and `audience`. |
| Job | `workspaceId` is nullable, see below. |

**CHILD (38).** Scoped through a foreign key to a ROOT parent; no column. Through Repository: ProjectRepository, RepositoryGrant,
WorkItem, WorkItemComment, ReviewRequest, Branch, MilestoneRepoLink, ForkMapping and its
children (UpstreamUpdateConfig, UpstreamUpdateRun, ForkComparison, UpstreamPrState, UpstreamIssueTriage, BackportRecord). Through
Project: ProjectMember, PlanningColumn, PlanningItem, TaskComment, TaskCheckItem, PlanningLink, PlanBoard, Epic, Iteration,
PlanEvent. Through Space: SyncEntity, OutboxOp, SyncConflict, HubRestore. Personal state keyed by `userId` (Device, SavedFilter,
NotificationPref, InboxState, SeenState, ReviewDraft, ViewedFile): owned by a person, and the work item or file ids inside them are
cuids that only exist in one workspace.

**GLOBAL (12), shared on purpose.**

- `OAuthClient`: an app that registered itself (RFC 7591, public client: name and exact redirect addresses, no secret). It names no workspace and holds nothing private; a person authorizes it for one workspace through an `OAuthGrant`. Capped (1000 rows, unused ones older than a day are forgotten when full).
- `User`, `Session`, `Identity`, `MagicLink`, `GithubSigninState`: a person's account and how they sign in (see `docs/auth.md`). A user belongs to workspaces through `Member`. `Session.activeWorkspaceId` only chooses among the person's own memberships and is re-checked on every request.
- `GithubOwner`: a public GitHub account (login, type, avatar) keyed by GitHub's immutable id. It holds nothing private and is the
  same for every tenant.
- `PublicCacheEntry`: ETag cache of GitHub API answers, keyed by request. The unprefixed keys are the shared cache and hold only
  answers any caller may see (the public port).
  Everything fetched with an installation token is stored under the prefix `inst:<installationId>:` (`dbCache(db, installationCachePrefix(id))`), so
  a private body can never be answered to a request made with another credential (tests/github-budget-cache.test.ts). A workspace
  never reads another workspace's data through it: the cache is only read by server-side sync, which stores into the workspace's own rows.
- `GithubInstallation`: one installation of the deployment's GitHub App on a GitHub account. The installation id is GitHub-global (one id, one
  account, however many workspaces use it), and the row holds only public account facts and state (login, type, repository selection,
  suspended and deleted times, and `lastWebhookAt`, the last verified webhook), no token and no key. Tenants reach it only through `WorkspaceInstallation`, the binding table, which is the
  tenant record and is ROOT. Tokens are minted only for a `BoundInstallation` (`src/lib/github/bound-installation.ts`), which `loadBoundInstallation` issues only for a proved, non-suspended, non-deleted binding of the workspace. Never read an installation's repositories or mint its token without first proving the workspace has the binding.
- `Repository.lastEventAt`: when a verified webhook last named the repository (at most once a minute); only paces the reconcile.
- `GithubDelivery`: webhook delivery ids already handled (replay protection), with the event name and installation id. The id is GitHub's
  and is unique across the deployment; the table holds no payload. Written only by the webhook route, in the same transaction as the handler's writes; pruned by `receivedAt` after 7 days. A webhook payload only FINDS rows: the installation must already exist, and repositories are matched only through `Repository.installationId` of a workspace binding (docs/github-app.md, "Webhooks").
- `GithubUserToken`, `GithubRepoAccess`: a person's own GitHub link (docs/github-app.md, "Linking your GitHub account"). Both are keyed by `userId` (cascading
  foreign key), like `User`, because a person's GitHub account is theirs and not a workspace's. `GithubUserToken` (one row per person) holds their GitHub token
  as AES-256-GCM ciphertext bound to the person; `GithubRepoAccess` caches what GitHub said they can open (repository GitHub id, the installation it came
  through, permission, `checkedAt`). Neither is ever read for anyone but the person: every query names the user id, and the only place the cache reaches a
  tenant is `validRepoGithubIds` (`src/lib/github/access-cache.ts`), which joins it to the viewer's OWN workspace's installation-tracked `Repository` rows and
  to the installation that serves them, so a row obtained through another workspace's installation grants nothing here. `repoWhere` then uses that list; stale
  rows (older than 30 minutes) grant nothing. Removing a member deletes the rows that came through that workspace's installations (unless another workspace the
  person still belongs to uses the same installation); unlinking deletes them all.
- `RateLimitState`: GitHub's quota belongs to a credential or an IP, which every tenant behind it shares. A repository's jobs spend from `installation:<id>` (`sourceBudgetKeyFor`), the quota of its
  installation token: workspaces sharing one installation share that budget, and one installation running dry never stalls another. `user:<id>` is the budget
  of one person's own GitHub token (the access refresh job): installation-independent, so a person cannot spend GitHub requests faster than their own limit,
  whatever workspaces they belong to.

## Hosted GitHub access

A hosted repository is read with its installation's token, resolved in one place (`portForSync` in `src/lib/github/factory.ts`):
`Repository.installationId` -> `loadBoundInstallation(db, repository.workspaceId, installationId)` (the only path to a token: proved, not
suspended, not deleted) -> `mintInstallationToken` -> `OctokitPort`. No binding gives the typed `GithubNotConnectedError`, which jobs treat as
"nothing to do" (DONE, no retry). An uninstalled or suspended installation is recorded on the global `GithubInstallation` row
(`markInstallationState`), so every workspace using it reads as not connected at once. Two workspaces sharing an installation each hold their
own `Repository` rows (unique on workspace and GitHub id), so each sees only what it tracked; and what a MEMBER sees of those rows is
`repoWhere` (docs/roles.md), never the token's reach. `workspaceGithubStatus(db, workspaceId)` (`src/lib/github/status.ts`) is the one answer to
"is this workspace connected" (`configured`, `bound`, `suspended`). Writes are not enabled: `portForWrite` throws "GitHub writes are not enabled yet".

## Jobs

`Job.workspaceId` is set on every per-tenant job (`sync.repository`, `sync.item`, `sync.fork`, upstream update and release checks).
`enqueue` takes it from the caller or, when the payload names a repository or a fork mapping, from that row. It is NULL only for the
three system-wide schedulers, `reconcile.all`, `digest.daily` and `ai.autopilot`: each runs once for the whole system and its handler
loops over the workspaces, queueing work that carries the workspace. The one other job without a workspace is `github.access.refresh`
(payload `{ userId }`, dedupe key `ghaccess:<userId>`): it belongs to a person, who may be a member of several workspaces; its body reads and writes
only that person's `GithubUserToken` and `GithubRepoAccess` rows and lists only installations bound to workspaces the person is an ACTIVE member of.
Claiming a job is system-wide on purpose (one worker serves all tenants).

## Active workspace

`loadViewer(db, userId, workspaceId)` requires an ACTIVE membership of that workspace. With no workspace given it accepts only a
user with exactly one membership, and returns null for several rather than guess. `resolveActiveWorkspaceId(db, user, cookie)` picks
the workspace: the only membership; else the `mp_ws` cookie if the user is an active member of it; else the oldest membership.
The cookie is untrusted input and only ever chooses among memberships the user already has. The hosted workspace switcher binds the choice to the login
session (`Session.activeWorkspaceId`, which wins over the cookie); the cookie remains a fallback for sessions with no binding.

Revoking a member (`status` REVOKED, set by removal or leaving) takes effect on the next request through that same check, and the
removal also unbinds their sessions from the workspace and deletes their ProjectMember and AccessSpaceMember rows
(`services/members.ts`). Another workspace of the same person is untouched.

Project visibility has two layers: `projectWhere` / `planningWhere` (membership and visible repositories, as before) and the access-space
filter `accessSpaceWhere`, applied to everyone including administrators: a project in a RESTRICTED space is invisible to anyone not
listed in it (see docs/roles.md).

Request paths always pass `viewer.workspaceId`. Code with no viewer (the worker's scheduler and job handlers) takes the workspace from the job row or fans out per workspace (`forEachWorkspace`); nothing relies on "the one workspace of this database" any more. The `firstWorkspace` helper and its allowlist went away with the single-profile code.
not use it.

The fan-out jobs (`reconcile.all`, `digest.daily`, `ai.autopilot`) run each workspace in id order inside its own try/catch; a failing
workspace is logged and the next still runs, and the job fails only when every workspace failed.

Backup restore checks every foreign key of a restored row: cards must name a column, epic and iteration of their own project and a
milestone of the workspace; triage and backport rows a fork mapping of the workspace; events and links cards of the workspace.
Anything else is skipped and listed.

## Enforcement

`tests/tenancy-scope.test.ts` scans `src/`, `scripts/` and `prisma/seed.ts` and fails when a call such as `db.repository.findMany(...)`,
`updateMany`, `deleteMany`, `count`, `aggregate`, `groupBy`, `findUnique`, `update`, `upsert`, `create` on a ROOT model has no workspace
scope in its arguments. ROOT models are read from `prisma/schema.prisma` (any model with `workspaceId`), so a new one is covered
automatically. A call counts as scoped when its arguments contain `workspaceId`, `repoWhere(`, `projectWhere(`, `wsScope(` or
`tenantWhere(`. Exceptions live in `src/lib/authz/tenancy-allowlist.ts`, each with a reason; the test also fails on an entry that no
longer matches anything.

Known blind spots of this regex scan (no type information):

- A `workspaceId` anywhere in the arguments counts, including inside `select`, `data` of another field or a comment-free string.
- Delegates reached through an alias (`const { repository } = db`, `const d = db.repository`) are not seen.
- Raw SQL (`$queryRaw`, `$executeRaw`) is not checked. The only uses today are the job claim, cache pruning, table truncation in the demo
  seed, and an `information_schema` read.
- CHILD models are not checked. A child query by id alone (`planningItem.findFirst({ where: { id } })`) is only safe if the id was
  already validated through its parent; the services use `planningWhere`, `viaRepo` and `requireX` for that.
- Nested writes and relation filters (`include: { repository: ... }`) are not inspected.
- Scoping by a variable (`where: scope`) is not recognised; spell the field out.

## Known gaps (later phases)

- The credential vault key (`vaultKeyFile`, `src/lib/hub/session-vault.ts`) is one file per install, shared by every workspace's `AiSettings` cipher.
  A hosted deployment needs a key per workspace or a KMS.
- `SavedFilter` is per person, not per workspace.
- Deleting a workspace cascades through every ROOT model. `PlanningItem.columnId` and `createdById` became
  `NO ACTION DEFERRABLE INITIALLY DEFERRED` so the cascade can remove cards, columns and members in one statement.
