/**
 * Calls of a ROOT-model Prisma delegate (a model with a `workspaceId` column) that are allowed to run without naming a workspace.
 * tests/tenancy-scope.test.ts fails on any other such call, and also fails on an entry here that no longer matches anything, so
 * this list cannot grow stale. Every entry needs a reason a reviewer can check. See docs/tenancy.md.
 *
 * `file` is the repository-relative path. `models` / `ops` narrow the entry (delegate names as in Prisma, for example "job" and
 * "updateMany"); leave them out to cover everything in the file.
 */
export type TenancyAllow = { file: string; models?: string[]; ops?: string[]; reason: string };

export const TENANCY_ALLOWLIST: TenancyAllow[] = [
  { file: "src/lib/authz/viewer.ts", models: ["member"], reason: "Identity resolution: the user's OWN active memberships (filtered by userId), used to pick the single workspace when the caller names none." },
  { file: "src/lib/auth/login.ts", models: ["member"], reason: "After sign-in: does this person (filtered by userId) belong to any workspace? Decides between the app and /onboarding." },
  { file: "src/lib/auth/workspaces.ts", models: ["member"], reason: "The workspace switcher lists the person's OWN active memberships (filtered by userId), across workspaces by design." },
  { file: "src/lib/jobs.ts", reason: "The job queue itself: claim, retry, recurrence and dedupe work on job ids / dedupe keys across all tenants by design (one worker serves every workspace). jobWorkspace() looks up the tenant of a payload's repository or mapping id so the job row can carry it." },
  { file: "src/lib/local/scheduler.ts", models: ["job"], reason: "The system-wide `reconcile` scheduler job (workspaceId null by design; it fans out per workspace in its handler)." },
  { file: "src/lib/local/scheduler.ts", models: ["workspaceInstallation"], reason: "System-wide scheduler (no workspace): counts whether ANY workspace has a usable GitHub connection, to decide whether to pace `reconcile.all`. Reads no tenant data; the handler fans out per workspace." },
  { file: "src/lib/github/webhook-maintenance.ts", models: ["githubAppState"], reason: "Daily housekeeping (a system job, no workspace): deletes install / OAuth states past their expiry in every workspace. Expired states are useless to everyone and hold only hashes." },
  { file: "src/lib/github/budget.ts", models: ["repository"], reason: "sourceBudgetKeyFor reads only the installationId of the repository a job names (the job carries its workspace); it picks which rate-limit budget the job spends from." },
  { file: "src/lib/local/discovery.ts", models: ["discoveryCache"], ops: ["updateMany"], reason: "Crash recovery: an attempt interrupted by a restart is reset in every workspace, because the process that ran it served all of them." },
  { file: "src/lib/github/demo.ts", reason: "Demo mode: the seeded database is one synthetic workspace; DemoPort only serves repositories flagged isDemo." },
  { file: "src/lib/github/factory.ts", models: ["repository"], reason: "portForSync loads a repository by an id taken from a job payload or from a caller that already scoped it (requireRepo / job.workspaceId); it decides demo vs real credential and, hosted, which installation serves it (the binding is then loaded with the repository's own workspaceId, never a caller's)." },
  { file: "src/lib/hub/gh-events.ts", reason: "Webhook ingest: an event names a GitHub repository id, and is applied to every tracked repository with that GitHub id; the review-request notification cleanup is keyed by a work item id." },
  { file: "src/lib/sync/repository.ts", reason: "Source sync internals run for one repository id taken from a job (or a webhook already matched to it); every row they touch hangs off that repository, so it is the tenant boundary." },
  { file: "src/lib/federation/provider.ts", models: ["federationGrant"], ops: ["findUnique"], reason: "A grant is looked up by the sha256 of its one-time code or bearer token: the secret names the tenant, so there is no workspace to filter on yet. Everything after the lookup is scoped by grant.workspaceId." },
  { file: "src/lib/federation/consumer.ts", models: ["federationLink"], ops: ["findFirst"], reason: "The OAuth callback finds the pending link by the sha256 of its one-use state AND the signed-in userId; the link then supplies the workspace for every later query." },
  { file: "src/lib/services/api-tokens.ts", models: ["apiToken"], ops: ["findUnique"], reason: "A personal access token is found by the sha256 of its secret: the secret names the tenant, so there is no workspace to filter on yet. The row then supplies the workspace for loadViewer and every later query (docs/mcp.md)." },
  { file: "src/lib/services/oauth.ts", models: ["oAuthCode", "oAuthRefresh"], ops: ["findUnique"], reason: "An authorization code or refresh token is found by the sha256 of its secret: the secret names the tenant, so there is no workspace to filter on yet. The row then supplies the workspace for every later query, including the single-use claim (docs/mcp.md, OAuth)." },
  { file: "src/lib/services/oauth.ts", models: ["member"], reason: "The consent page lists the caller's OWN active memberships (filtered by userId): the workspaces they may authorize an app for, across workspaces by design." },
  { file: "prisma/seed.ts", reason: "Seed script: refuses to run when real data exists and wipes the whole demo database." },
];

/**
 * Files that may call `firstWorkspace(db)`: single-profile plumbing with no workspace of its own. `firstWorkspace` FAILS CLOSED
 * (it throws when the database holds more than one workspace), so these paths refuse to run multi-tenant instead of silently
 * serving the oldest tenant. Request paths with a viewer must pass `viewer.workspaceId` instead and are not listed here.
 * tests/tenancy-scope.test.ts fails on any other file and on an entry that no longer calls it.
 */
export const FIRST_WORKSPACE_ALLOWLIST: { file: string; reason: string }[] = [
  { file: "src/lib/local/profile.ts", reason: "Defines it, and ensureLocalProfile bootstraps the profile's one workspace." },
  { file: "src/lib/sync/engine.ts", reason: "Default workspace of an engine built without one (local profile); the runtime always passes it." },
  { file: "src/lib/team/service.ts", reason: "Default workspace of a TeamService built without an engine or workspace (local profile)." },
  { file: "src/lib/local/runtime.ts", reason: "Process singletons of the local app: default workspace when a caller names none, and the hub-link guard." },
  { file: "src/lib/local/scheduler.ts", reason: "The in-process local scheduler dispatches desktop toasts for the profile's one workspace." },
  { file: "src/lib/local/discovery.ts", reason: "Discovery cache of the profile; callers with a viewer pass the workspace, the retry scheduler has none." },
  { file: "src/lib/local/discovery-jobs.ts", reason: "Space lookup for the background invitation-status refresh started by the local scheduler." },
  { file: "src/lib/local/repo-watch.ts", reason: "The local repository watcher runs in the scheduler process for the profile's one workspace." },
  { file: "src/lib/local/watch-settings.ts", reason: "Default workspace when the caller (the watcher) has no viewer; the settings action passes the viewer's." },
  { file: "src/lib/hub/session-vault.ts", reason: "Hub login of the profile: ports and the live link have only a db file; callers with a viewer pass the workspace." },
  { file: "src/lib/hub/github-app-install.ts", reason: "Coverage caches of the profile's hub link; callers with a viewer pass the workspace." },
  { file: "src/lib/hub/instant-badges.ts", reason: "Badge lookup defaults to the profile's workspace; the repositories page passes the viewer's." },
  { file: "src/lib/hub/ports-impl.ts", reason: "Hub profile ports work on a profile db file (connect flow) with no viewer." },
  { file: "src/lib/hub/watch.ts", reason: "The hub watch set of the profile's single hub link." },
];
