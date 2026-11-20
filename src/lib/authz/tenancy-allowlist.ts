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
  { file: "src/lib/jobs.ts", reason: "The job queue itself: claim, retry, recurrence and dedupe work on job ids / dedupe keys across all tenants by design (one worker serves every workspace). jobWorkspace() looks up the tenant of a payload's repository or mapping id so the job row can carry it." },
  { file: "src/lib/local/scheduler.ts", models: ["job"], reason: "The system-wide `reconcile` scheduler job (workspaceId null by design; it fans out per workspace in its handler)." },
  { file: "src/lib/local/discovery.ts", models: ["discoveryCache"], ops: ["updateMany"], reason: "Crash recovery: an attempt interrupted by a restart is reset in every workspace, because the process that ran it served all of them." },
  { file: "src/lib/github/demo.ts", reason: "Demo mode: the seeded database is one synthetic workspace; DemoPort only serves repositories flagged isDemo." },
  { file: "src/lib/github/factory.ts", models: ["repository"], reason: "portForSync loads a repository by an id taken from a job payload or from a caller that already scoped it (requireRepo / job.workspaceId); it only decides demo vs real credential." },
  { file: "src/lib/hub/gh-events.ts", reason: "Webhook ingest: an event names a GitHub repository id, and is applied to every tracked repository with that GitHub id; the review-request notification cleanup is keyed by a work item id." },
  { file: "src/lib/sync/repository.ts", reason: "Source sync internals run for one repository id taken from a job (or a webhook already matched to it); every row they touch hangs off that repository, so it is the tenant boundary." },
  { file: "prisma/seed.ts", reason: "Seed script: refuses to run when real data exists and wipes the whole demo database." },
];
