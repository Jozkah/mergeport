# Architecture

Mergeport is a hosted, multi-tenant web application. One deployment serves many workspaces from one PostgreSQL database; the web process renders pages and handles actions, and a separate worker process (`npm run worker`) runs the background jobs. GitHub is read through a GitHub App (installation tokens per workspace, user-to-server tokens for per-person access, signed webhooks); people sign in with a magic link or OIDC. See `docs/tenancy.md`, `docs/auth.md`, `docs/github-app.md`, `docs/federation.md` and `docs/mcp.md`.

```
 browser ──▶ web (Next.js) ──▶ PostgreSQL ◀── worker (jobs: sync, digests, webhook upkeep)
                │                                 │
                ├── GitHub App ───────────────────┴──▶ GitHub (installation + user tokens, webhooks in)
                ├── /api/mcp (tokens, OAuth) ◀── AI apps
                └── federation (read-only links) ◀──▶ other Mergeport instances
```

## Decisions

| Decision | Why |
| --- | --- |
| One PostgreSQL database, every tenant row scoped by `workspaceId` | One deployment serves many workspaces; isolation is enforced in the query and checked by tests (`docs/tenancy.md`) |
| GitHub is the source of truth for issues, PRs, reviews, labels | Fetched through the App installation or the person's own access and stored in Postgres; Mergeport never claims to know more than the last successful fetch, and says how old it is |
| Webhooks and a worker, not page-time fetches | Pages render from stored data and its age; the worker refreshes it, and signed GitHub webhooks keep it close to live |
| Roles are workspace roles set by an admin; GitHub access is checked per person | A role is never read from a file or a field a member can edit |
| GSAP only for board layout animation; everything else CSS | One owner per animated element; dnd-kit keeps the drag transform |

## Storage and migration

`src/lib/db.ts` opens PostgreSQL through Prisma's pg adapter (`DATABASE_URL`). Schema changes are SQL migrations in `prisma/migrations/`, applied with `prisma migrate deploy` (`npm start`, `npm run db:migrate`). The old SQLite-era migrations and the custom runner that applied them were removed; `prisma/legacy/` keeps only the historical Postgres schema and migrations for reference.

## Authentication

People sign in with a magic link or OIDC (`docs/auth.md`); the session cookie is `HttpOnly`, `SameSite=Strict` and stored hashed. Mergeport holds no GitHub credential of its own: a workspace reads GitHub through its own GitHub App installation (short-lived installation tokens, minted per binding the workspace proved), and a person's own access comes from a user-to-server token they linked themselves, stored encrypted (`docs/github-app.md`). Application code reaches GitHub only through the ports in `src/lib/github/factory.ts`: `portForSync` (the repository's installation; a repository without a usable binding gets the typed `GithubNotConnectedError`, which jobs finish as a no-op), `portForWrite` (refuses with `GithubWritesDisabledError`; the opt-in issue and comment writes in `src/lib/github/writes.ts` do not use it, they act with the person's own user token, see `docs/github-app.md`) and `publicPort` (public data, no credential). Demo repositories are served by an in-database `DemoPort`.

## Server boundary

- `src/proxy.ts` refuses any `Host` that is not the public host (hosted) or, for the demo run (`npm run demo`, no `MERGEPORT_PUBLIC_URL`), a loopback name (`127.0.0.1`, `localhost`, `[::1]`, which blocks DNS rebinding) and any state-changing request without a same-origin `Origin` or `Sec-Fetch-Site`, and marks every response `no-store`. Server-to-server callers (federation, the GitHub webhook, MCP and OAuth machine endpoints) are exempt only on their exact paths and only when plainly not a browser.
- The session cookie is `HttpOnly`, `SameSite=Strict`, minted by a sign-in (magic link, OIDC, or the demo sign-in), stored hashed.
- `/api/sync/events` is a server-sent-events stream used only for live refresh of the pages open on that web process.

## Workspaces

A deployment holds many workspaces in one Postgres database; see `docs/tenancy.md` for how every query is scoped to one.

## Scheduler

`src/lib/jobs.ts` is the job queue; `src/lib/worker/scheduler.ts` runs it inside the worker process (`npm run worker`, `scripts/worker.ts`). The web process runs no jobs. A recurring job (`reconcile.all`) carries its own `intervalMs`; the runner re-queues it after each run. A trigger that arrives **while a run is in flight** sets `dirty`, and the run requeues immediately instead of the trigger being swallowed. This fixes the original defect, where a self-reschedule under the same dedupe key during `RUNNING` was dropped and the job was then marked `DONE`. After a restart a recurring job runs once and then waits a full interval.

Source sync is `sync.repository`, `sync.item` and `sync.fork` (`src/lib/worker/handlers.ts` calling `src/lib/sync/repository.ts` through `portForSync`, so each repository is read with its own installation). `reconcile.all` fans out per workspace: a workspace with a usable connection gets `enqueueHostedReconcile` (hourly when its installation sends webhooks, every cycle otherwise), and the same job renews the cached GitHub access of linked people. Webhooks enqueue targeted refreshes. The old GitHub-repository team-space sync engine and the repository watcher were removed; nothing polls GitHub on a per-tab basis.

## Daily digest

Each local day Mergeport writes the person a digest of the previous day: what was done, what was left undone, what needs them, and what is waiting on other people. It is deterministic and local: built by `src/lib/services/digest.ts` from the local database only, with no model, no network call, no new secret and no write to GitHub, and with the same viewer scoping as every other page (`repoWhere`/`planningWhere`; a repository the person cannot see contributes no entry, count or title). Sources: tasks that moved to done (`PlanEvent`), pull requests merged and issues closed that were authored by or assigned to the person, reviews they gave, backports marked done (both sides of the fork mapping visible); open assigned items, their own open pull requests, overdue or ended-iteration tasks and unsent `ReviewDraft` comments; the `attention()` queues, failing checks and conflicts on their pull requests, unread inbox, repositories with a sync error or disconnected; manual waiting records and review requests older than 2 days that the reviewer has not answered (with who). Each section keeps 15 entries plus a "more" count. The day is a local calendar date (`src/lib/domain/digest.ts`): the window is `[start of the day, start of the next)` computed from the zone's own offsets, so it is 23 or 25 hours on a daylight-saving change.

**Extension point.** `registerDigestSource(name, fn)` (or the `sources` option of `buildDigest`) adds entries per section (`done`, `undone`, `mine`, `others`); a source is responsible for scoping its entries to the viewer, and one that throws is skipped.

**Storage and schedule.** `DailyDigest` holds one row per person and reported day (`@@unique([userId, day])`, JSON payload, `readAt`); it is personal, never synchronised and not part of the backup. The recurring job `digest.daily` (every 10 minutes, `ensureRecurring` in the scheduler tick, handler in `handlers.ts`) calls `runDailyDigest`: once the configured hour (default 08:00, local) has passed and the previous day has no digest, it generates one. A job that is due after the app was closed runs on the first tick after start, so a missed hour is caught up; the unique row makes a second generation impossible, and only the Regenerate button replaces a digest (it creates no second notification). A new digest also creates one `Notification` (kind `daily-digest`, link `/digest?day=...`), subject to the person's in-app preference for that kind. Settings (switch and hour) live in the personal notification preferences (`NotificationPref.prefs.digest`) and are edited under Settings, "Daily digest". Pages: `/digest` (stored days, older/newer, Regenerate, Mark read), a card on Overview and a sidebar entry with the unread count. Demo mode has no scheduler, so its first digest is made on demand from the demo data.

## Authorization of data

`src/lib/authz/viewer.ts` is the single place visibility is defined. `repoWhere(viewer)` is a SQL filter evaluated per request, not a cached list. Inside a workspace, a person's capabilities over a repository come from their role and their repository grant; what they can open on GitHub is checked per person. Missing and hidden both produce the same `NotFoundError`; `ForbiddenError` is used only when the item is visible and the capability is not. Planning cards linked to a GitHub item inherit that repository's visibility; a hidden blocker still blocks and appears as an opaque marker.

## Agents

AI apps reach Mergeport through the hosted MCP endpoint (`src/lib/mcp`, `POST /api/mcp`, personal access tokens and OAuth; see `docs/mcp.md`). The task commands it runs live in `src/lib/task-commands/mp.ts`. The old `npm run mp` command line and the stdio MCP server read a local profile database, and were removed with the local launcher.

## Review waiting

`src/lib/domain/review.ts` derives the waiting state from real review requests and review results plus the resolved routing rule. A comment or a label change never counts as approval. Approvals on an older commit are stale. GitHub's requested-reviewers endpoint has no timestamp, so "waiting since" is when Mergeport first saw the request (labelled "request first seen").

## Theme and motion

See `DESIGN.md` ("Dark theme", "Motion") and `docs/motion.md` (motion matrix, tokens, ownership rules, evidence, reference ledger). The theme is a cookie rendered into `<html data-theme>` on the server; tokens are defined once and overridden for dark.

## Limitations (stated, not hidden)

- Data is as fresh as the last webhook or reconcile run; every page shows the age.
- Writes to GitHub are off for real repositories (the App holds read permissions); the demo store accepts them.
- Public repositories added by URL have no installation and are not refreshed in a hosted workspace.
- Revoking a person's access stops them reading; it cannot unread what they already saw.
- GitHub App behaviour (installation lifecycle, SSO, throttling, user-token refresh) is simulated by `src/lib/github/fake-server.ts` in tests; real-account verification is described in `docs/github-app.md`.

## Verification

Automated: `npm test` (Vitest on an embedded PostgreSQL, port 5434) covers tenancy and role scoping, the GitHub App flows against a fake GitHub, webhook handling, the scheduler and job queue, sync idempotency, backup and restore, federation, MCP and OAuth, and the UI pages rendered per role. `npx tsc --noEmit`, `npx eslint .` and `npm run build` must be clean. Run the commands for current counts; they change with every commit.
