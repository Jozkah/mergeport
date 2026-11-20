# Tenancy

Mergeport runs many workspaces in one Postgres. A workspace is the tenant. Every row a tenant owns is reachable only through
that workspace, and every query on tenant data names the workspace.

## Model classification

65 models: 1 tenant anchor, 22 ROOT, 37 CHILD, 5 GLOBAL.

**Tenant anchor.** `Workspace` is the tenant itself.

**ROOT (22).** The model has a `workspaceId` column, a foreign key to `Workspace` with `ON DELETE CASCADE`, and an index that
starts with it (a unique key that starts with it counts). Every query on a ROOT model must name the workspace.

| Model | Notes |
| --- | --- |
| Member, Repository, Project | Repository is unique on (workspaceId, githubId). Project is unique on (workspaceId, slug). |
| ReviewRule, WaitingRule, WaitingRecord | WaitingRecord, ReviewerAvailability, LabelMap and UpstreamSubscription had the column but no foreign key; the migration adds it. |
| DashboardMilestone, ReviewerAvailability, LabelMap, UpstreamSubscription | |
| Notification, AuditLog, DailyDigest | DailyDigest is unique on (workspaceId, userId, day): a person in two workspaces gets one digest per workspace. |
| Space | Unique on (workspaceId, backend, repoOwner, repoName, hubSpaceId): two workspaces may join the same coordination repository. |
| TeamConfig, HubSession, AiSettings | Were fixed-id singletons (`team`, `session`, `ai`). Now one row per workspace: `workspaceId` is unique, the id is a cuid. |
| AiSuggestion, AiPendingAction | |
| GitCache, DiscoveryCache | Primary key is (workspaceId, key). The git cache holds private repository content, and discovery lists come from one person's credential, so neither may be shared across tenants. |
| Job | `workspaceId` is nullable, see below. |

**CHILD (37).** Scoped through a foreign key to a ROOT parent; no column. Through Repository: ProjectRepository, RepositoryGrant,
WorkItem, WorkItemComment, ReviewRequest, Branch, MilestoneRepoLink, DeviceRepoMapping, WorktreeSnapshot, ForkMapping and its
children (UpstreamUpdateConfig, UpstreamUpdateRun, ForkComparison, UpstreamPrState, UpstreamIssueTriage, BackportRecord). Through
Project: ProjectMember, PlanningColumn, PlanningItem, TaskComment, TaskCheckItem, PlanningLink, PlanBoard, Epic, Iteration,
PlanEvent. Through Space: SyncEntity, OutboxOp, SyncConflict, HubRestore. Personal state keyed by `userId` (Device, SavedFilter,
NotificationPref, InboxState, SeenState, ReviewDraft, ViewedFile): owned by a person, and the work item or file ids inside them are
cuids that only exist in one workspace.

**GLOBAL (5), shared on purpose.**

- `User`, `Session`: a person's account and login. A user belongs to workspaces through `Member`.
- `GithubOwner`: a public GitHub account (login, type, avatar) keyed by GitHub's immutable id. It holds nothing private and is the
  same for every tenant.
- `PublicCacheEntry`: ETag cache of GitHub API answers, keyed by request. A 304 is only given to a caller GitHub has authorised, so
  sharing it saves rate limit without sharing access. Caveat: `ghPort` also writes answers fetched with a person's credential;
  before hosted workspaces use their own credentials, partition the key by credential or use it for the public port only.
- `RateLimitState`: GitHub's quota belongs to a credential or an IP, which every tenant behind it shares. The `source` key is the
  signed-in profile's budget; a hosted deployment with one credential per workspace must prefix it.

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
The cookie is untrusted input and only ever chooses among memberships the user already has. Nothing sets the cookie yet (no
switcher UI in this phase).

Code with no signed-in viewer (the local scheduler, hub link, discovery caches, the sync engine and team service of a local profile)
uses `firstWorkspace(db)`, the profile's one workspace. `SyncEngine` and `TeamService` accept an explicit `workspaceId`; a hosted
worker must pass it.

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
- `PublicCacheEntry` and `RateLimitState` keys are not partitioned by credential (see above).
- The hub link (`src/lib/hub`), discovery caches and the in-process scheduler serve one workspace per process.
- Deleting a workspace cascades through every ROOT model. `PlanningItem.columnId` and `createdById` became
  `NO ACTION DEFERRABLE INITIALLY DEFERRED` so the cascade can remove cards, columns and members in one statement.
