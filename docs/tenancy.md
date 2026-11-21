# Tenancy

Mergeport runs many workspaces in one Postgres. A workspace is the tenant. Every row a tenant owns is reachable only through
that workspace, and every query on tenant data names the workspace.

## Model classification

79 models: 1 tenant anchor, 31 ROOT, 38 CHILD, 9 GLOBAL.

**Tenant anchor.** `Workspace` is the tenant itself.

**ROOT (31).** The model has a `workspaceId` column, a foreign key to `Workspace` with `ON DELETE CASCADE`, and an index that
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
| Job | `workspaceId` is nullable, see below. |

**CHILD (38).** Scoped through a foreign key to a ROOT parent; no column. Through Repository: ProjectRepository, RepositoryGrant,
WorkItem, WorkItemComment, ReviewRequest, Branch, MilestoneRepoLink, DeviceRepoMapping, WorktreeSnapshot, ForkMapping and its
children (UpstreamUpdateConfig, UpstreamUpdateRun, ForkComparison, UpstreamPrState, UpstreamIssueTriage, BackportRecord). Through
Project: ProjectMember, PlanningColumn, PlanningItem, TaskComment, TaskCheckItem, PlanningLink, PlanBoard, Epic, Iteration,
PlanEvent. Through Space: SyncEntity, OutboxOp, SyncConflict, HubRestore. Personal state keyed by `userId` (Device, SavedFilter,
NotificationPref, InboxState, SeenState, ReviewDraft, ViewedFile): owned by a person, and the work item or file ids inside them are
cuids that only exist in one workspace.

**GLOBAL (9), shared on purpose.**

- `User`, `Session`, `Identity`, `MagicLink`: a person's account and how they sign in (see `docs/auth.md`). A user belongs to workspaces through `Member`. `Session.activeWorkspaceId` only chooses among the person's own memberships and is re-checked on every request.
- `GithubOwner`: a public GitHub account (login, type, avatar) keyed by GitHub's immutable id. It holds nothing private and is the
  same for every tenant.
- `PublicCacheEntry`: ETag cache of GitHub API answers, keyed by request. The unprefixed keys are the shared cache and hold only
  answers any caller may see: the public port, and the local app's own single credential (`ghPort`, not used on a hosted deployment).
  Everything fetched with an installation token is stored under the prefix `inst:<installationId>:` (`dbCache(db, installationCachePrefix(id))`), so
  a private body can never be answered to a request made with another credential (tests/github-budget-cache.test.ts). A workspace
  never reads another workspace's data through it: the cache is only read by server-side sync, which stores into the workspace's own rows.
- `GithubInstallation`: one installation of the deployment's GitHub App on a GitHub account. The installation id is GitHub-global (one id, one
  account, however many workspaces use it), and the row holds only public account facts and state (login, type, repository selection,
  suspended and deleted times), no token and no key. Tenants reach it only through `WorkspaceInstallation`, the binding table, which is the
  tenant record and is ROOT. Tokens are minted only for a `BoundInstallation` (`src/lib/github/bound-installation.ts`), which `loadBoundInstallation` issues only for a proved, non-suspended, non-deleted binding of the workspace. Never read an installation's repositories or mint its token without first proving the workspace has the binding.
- `GithubDelivery`: webhook delivery ids already handled (replay protection), with the event name and installation id. The id is GitHub's
  and is unique across the deployment; the table holds no payload. Pruned by `receivedAt`.
- `RateLimitState`: GitHub's quota belongs to a credential or an IP, which every tenant behind it shares. The `source` key is the
  local app's single credential. A hosted repository's jobs spend from `installation:<id>` (`sourceBudgetKeyFor`), the quota of its
  installation token: workspaces sharing one installation share that budget, and one installation running dry never stalls another.

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
loops over the workspaces, queueing work that carries the workspace. Claiming a job is system-wide on purpose (one worker serves
all tenants).

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

Request paths always pass `viewer.workspaceId`: discovery lists (`readCached`), the sync engine and team service (cached per workspace in
`getEngine(workspaceId)` / `getTeamService(workspaceId)`), the hub coverage caches, the hub login vault, watch settings and leaving a team
(`leaveTeamLocally(db, workspaceId)` requires it, and the action requires an administrator).

Code with no viewer (the local scheduler, repository watcher, hub link and its ports, discovery retries) uses `firstWorkspace(db)`.
It FAILS CLOSED: it throws when the database holds more than one workspace, so these paths refuse to run multi-tenant instead of
silently serving the oldest tenant. Fail-closed paths today: the hub live link (it also refuses to start for any workspace but the
only one), `hubSessionPort`, `getHubTeamService`, the background discovery refresh and retry, the repository watcher, desktop toasts,
and an engine or team service built without a workspace. `tests/tenancy-scope.test.ts` allows `firstWorkspace(` only in the files
listed in `FIRST_WORKSPACE_ALLOWLIST`, each with a reason. This local and hub code is scheduled for removal; a hosted deployment does
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

- The credential vault key (`keyFileFor`) is one file per install, shared by every workspace's `HubSession` and `AiSettings` cipher.
  A hosted deployment needs a key per workspace or a KMS.
- `SavedFilter` is per person, not per workspace, and its shared-view sync lists the profile's first user.
- Local-app `ghPort` answers still use the unprefixed `PublicCacheEntry` keys and the `source` budget (one credential per profile; not used hosted).
- The hub link (`src/lib/hub`), discovery caches and the in-process scheduler serve one workspace per process.
- Deleting a workspace cascades through every ROOT model. `PlanningItem.columnId` and `createdById` became
  `NO ACTION DEFERRABLE INITIALLY DEFERRED` so the cascade can remove cards, columns and members in one statement.
