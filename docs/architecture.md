# Architecture

Mergeport is a local-first application. Each person runs it on their own computer, against their own SQLite database, authenticated to GitHub through the official GitHub CLI. By default a team shares Mergeport-owned data through private GitHub repositories, and there is no server to deploy. The diagram below shows that GitHub mode. (The optional single-team hub server and its client were removed; see "Hub removal" under Sync.)

```
 your computer                                     GitHub
┌───────────────────────────────┐   gh api    ┌───────────────────────────┐
│ browser ── 127.0.0.1 ── Next.js │ ──────────▶ │ source repos (issues, PRs) │  your access
│            │                    │             ├───────────────────────────┤
│            ├─ SQLite profile    │ ◀────────── │ mergeport-<team>-workspace │  common space (private)
│            ├─ sync engine       │             │ mergeport-<team>-<space>   │  restricted spaces (private)
│            └─ outbox (durable)  │             └───────────────────────────┘
└───────────────────────────────┘
```

## Decisions

| Decision | Why |
| --- | --- |
| Loopback server, one SQLite file per `(host, GitHub user id)` | No infrastructure; accounts never share a database; a switch of the `gh` account locks the app instead of mixing data |
| GitHub is the source of truth for issues, PRs, reviews, labels | Fetched with the acting person's access and cached locally; Mergeport never claims to know more than the last successful fetch, and says how old it is |
| Mergeport-owned data lives in private "space" repositories | The repository **is** the audience. Privacy is a property of where data is stored, not of what the UI hides |
| One JSON file per entity, optimistic concurrency by blob SHA and non-force ref updates | Independent edits merge; same-record edits surface as a conflict; no server arbitration needed |
| Polling, not webhooks, in the default mode | A local app has no public address and must not need a tunnel. Consistency is eventual and the delay is published. The optional hub adds a live WebSocket link and can relay GitHub App webhooks to apps ("Hub webhook relay"); the local app itself never receives a webhook |
| Roles from GitHub permissions | An editable role string would be a forgery vector |
| GSAP only for board layout animation; everything else CSS | One owner per animated element; dnd-kit keeps the drag transform |

## Storage and migration

`src/lib/db.ts` opens PostgreSQL through Prisma's pg adapter (`DATABASE_URL`). Schema changes are SQL migrations in `prisma/migrations/`, applied with `prisma migrate deploy` (`npm start`, `npm run db:migrate`). The old SQLite-era migrations and the custom runner that applied them were removed; `prisma/legacy/` keeps only the historical Postgres schema and migrations for reference.

## Authentication

`src/lib/github/exec.ts` runs the CLI: `spawn` with an argument array and no shell, a timeout and an `AbortSignal` on every call, a tracked set of live children (`terminateAllGh` at shutdown), a size cap on output, executable discovery (PATH, then the usual install folders), refusal of `.cmd`/`.bat` shims, and tree-kill on timeout or cancel. `src/lib/github/gh.ts` turns `fetch` into `gh api -i`, drops credential headers, passes bodies on stdin, and rejects request paths that look like options.

**Account binding (`src/lib/github/bound.ts`, `src/lib/local/profile-runner.ts`).** Application code reaches GitHub only through a runner bound to the profile's account. The CLI's globally selected account is never trusted, because a re-check before a call cannot close the gap between the check and the call. Instead the runner (1) asks for THIS account's token (`gh auth token --user <login>`), (2) verifies with that token that it belongs to the profile's numeric id, (3) runs every call with that token in the child's environment. A different id, a signed-out account or an old CLI block the call (an `IdentityError`, shown to the caller as a 401 with `x-mergeport-identity` and an actionable message); a 401 forgets the token; unreachable GitHub during verification behaves as offline. Inherited tokens are stripped from children and a token echoed on stderr is redacted.

`src/lib/local/identity.ts` reports, for display only, which account `gh` has selected. It answers from the last known value and refreshes in the background, so a page never waits on `gh`. A mismatch becomes a note in the layout; a missing or signed-out `gh` keeps the saved data readable and sends nothing. Scope honesty is in `docs/github-cli-setup.md`.

## Background discovery and offline behavior

Pages read the last known result from the local database (`DiscoveryCache`) and show how old it is. `src/lib/local/discovery.ts` refreshes in the background: one refresh per list at a time (callers share it), a deadline and an `AbortSignal` per attempt, at most three attempts with 2 s and 8 s backoff, then the scheduler retries after two minutes. A failure **keeps the saved list** and records why: offline, rate limited (waits for the reset), sign-in needed (waits for the person), or error. A failed refresh is never turned into an empty list or a "synced" state. Shutdown cancels refreshes and kills their `gh` processes; an attempt a crash interrupted is marked on the next start. The only live GitHub calls made while a page renders are ones the person just asked for (reviewing a team plan, opening a join link), each with a hard 12 s deadline.

## Local server boundary

- `scripts/start-local.ts` picks the profile, binds `127.0.0.1`, and opens a one-time launch link. The launch token is compared in constant time and works once.
- `src/proxy.ts` refuses any `Host` outside `127.0.0.1`, `localhost`, `[::1]` (DNS rebinding) and any state-changing request without a same-origin `Origin` or `Sec-Fetch-Site`, and marks every response `no-store`.
- The session cookie is `HttpOnly`, `SameSite=Strict`, minted only by the launcher link (or the demo sign-in), stored hashed.
- `/api/sync/events` is a server-sent-events stream used only for live refresh; `/api/sync/visibility` lets the page tell the engine whether it is visible so polling can slow down.

## Spaces and teams

A **space** is a private repository with a manifest `mergeport.json`:

```json
{ "schema": 1, "kind": "mergeport-space", "spaceId": "…", "teamId": "…", "teamName": "…",
  "spaceKind": "COMMON" | "RESTRICTED", "name": "…", "createdAt": "…", "createdBy": { "id": "…", "login": "…" } }
```

The common space is `mergeport-<team>-workspace`; a restricted space is `mergeport-<team>-<space>`. Entities live at `entities/<type>/<id>.json` as `{ schema, type, id, version, deleted, appliedOps[], updatedAt, updatedBy, data }`. The repository only ever holds Mergeport-owned entities: repository declarations, projects and boards, internal tasks, cross-repository milestones, routing configuration, waiting annotations and triage decisions.

**Create a team** (`src/lib/team/service.ts`): the app first shows the exact repository name, owner, visibility (always private), purpose and the permissions it will need, and does nothing until the person confirms. A name collision picks a new suffix; an existing repository is never overwritten. The manifest is written with stable ids.

**Invite**: native GitHub collaborator invitations, or a join link. A join link names a repository (`/join?repo=owner/name`); it is not a token and grants nothing. Invitation status is reported as pending, accepted, expired or failed.

**Join is explicit.** The teammate accepts GitHub's invitation and signs in as themself. Mergeport then discovers candidate repositories and shows, for each, the owner, visibility, the team and creator its manifest names, the access they would have, what it contains, what joining downloads (the manifest and shared entity files, nothing executed) and what it publishes (nothing by itself). Only the Join button, after a confirmation box, imports shared state and enables sync, and it re-validates everything and refuses if the GitHub repository id differs from the one shown. A candidate is joinable only if GitHub says it is private, not a fork and readable; its manifest is valid and of a supported schema; and, once in a team, it belongs to that team **and** sits under the same owner as the team's common space; for a personal-account owner the manifest's creator must be that owner; if it was joined before it must be the same repository by numeric id. A name prefix or a copied manifest alone is never enough. Public or untrusted repositories are rejected; the first join must be the common space.

**Restricted audiences get their own repository.** The common manifest does not list restricted spaces. Each person's app discovers the spaces their GitHub access reveals (candidates, then an explicit Join), and the owner's app aggregates what that owner can read. Data a person may not see is never written to a repository they can read.

**Roles** come from the `permissions` GitHub returns for the person on the common space (`refreshRole`): admin maps to team administration, push to editing, pull to read-only. Nothing in a JSON file or the local database is trusted for authority, so a forged `role: "admin"` changes nothing. Removing a collaborator in GitHub is how access is revoked.

**Source access** is separate: seeing a shared repository does not give a teammate its issues. Where a person cannot read the source repository the UI says "Source repository access required".

## Workspaces

A hosted deployment holds many workspaces in one Postgres database; see `docs/tenancy.md` for how every query is scoped to one. The local launcher, its per-account SQLite profiles, the supervisor and the workspace switcher between profiles were removed.

## Sync

Each person's database holds the working copy. `SyncEngine` (`src/lib/sync/engine.ts`) reconciles it with each space:

1. **Capture**: diff the local read model against the last synced base (`SyncEntity`) and write a durable `OutboxOp` per changed entity. Nothing is lost if the app closes.
2. **Pull**: conditional head check (ETag, `304` costs nothing), recursive tree, fetch only blobs whose SHA changed, then a **three-way merge** with base, local and remote. Independent field edits merge. Same-field edits open a `SyncConflict` that keeps both values.
3. **Push**: create blobs, a tree on the head just read, a commit, then a **fast-forward-only** ref update. If the ref moved (`HeadMovedError`) the loop pulls and retries. A lost response is detected by `appliedOps` in the file, so retries are idempotent and an operation is never applied twice.
4. **Conflicts** are resolved by the person (`mine` or `theirs`); neither version is discarded before then.
5. **Deletes** are tombstones (`deleted: true`), so a delete is a version like any other and cannot be resurrected by a stale copy.

Per-space state shown to the person: **Pending, Syncing, Synced, Offline, Conflict, Access revoked** (plus Rate limited, Update needed, Read only).

**Consistency delay (published in the UI).** Polling base is 30 s while the app is open and visible (configurable, minimum 15 s). Unchanged polls back off (the interval doubles for every 4 unchanged polls: 30 s, then 60 s, then the cap of 2 min, `MAX_POLL_MS` in `src/lib/sync/engine.ts`) with ±20% jitter, and any change resets it. The scheduler ticks every 5 s; with a hidden tab or none open (no page report for 90 s) the engine ticks at most once a minute, and with the app closed nothing runs. Source repositories have their own cycle: `reconcile.all` every 15 minutes, plus the visible-tab repository watcher below (default every 15 s per repository). Hub spaces are left to the live socket while it is up ("Live link"). A teammate's change typically appears within about `poll/2 + 2` s when active. It is **not real time**.

**Rate limits.** Two lanes with separate budgets: the coordination lane (`engine.tick()`) and the source-repository job queue. Exhausting one never starves the other. `Retry-After` / reset times set `rateLimitedUntil`.

**Revoked access.** On `403/404` for a space the engine stops reading and writing it, quarantines unsent operations (`QUARANTINED`), and purges cached rows that came from it. The person can retry the sent operations if access returns or discard them. Git history on GitHub is not erased and the UI says so.

**Schema skew.** A space or entity file with a newer schema is read-only (`SCHEMA_NEWER`); unknown entity files are skipped and never rewritten by an older client.

### Hub removal

The old single-team hub (server in `hub/`, client in `src/lib/hub/`, connect flow, hub Team page, GitHub App webhook relay) was deleted. What is left on purpose, until a dedicated change removes it with its data model:

- `SyncEngine` still dispatches on `Space.backend` (`GITHUB` or `HUB`, `pullHub`/`pushHub`, `HubClient` in `src/lib/hub/types.ts`). No code provides a hub client any more, so a `HUB` space throws "No hub client configured".
- The tables `HubSession`, `HubRestore` and the `hub*` columns on `Space` and `TeamConfig` stay (no migration drops them here).
- `src/lib/hub/session-vault.ts` now only holds `openVault`/`keyFileFor`, the AES-GCM helper for the AI provider key.
- `hubs.json` and `hub-<fingerprint>` backend ids in the profile registry are still read by the workspace switcher.

## Scheduler

`src/lib/jobs.ts` is the local job queue; `src/lib/local/scheduler.ts` runs it from `instrumentation.ts`. A recurring job (`reconcile.all`) carries its own `intervalMs`; the runner re-queues it after each run. A trigger that arrives **while a run is in flight** sets `dirty`, and the run requeues immediately instead of the trigger being swallowed. This fixes the original defect, where a self-reschedule under the same dedupe key during `RUNNING` was dropped and the job was then marked `DONE`. After a restart a recurring job runs once and then waits a full interval.

### Auto-sync of repositories without webhooks

Repositories the App cannot cover (public repositories added by URL, anything the hub does not report as covered) never send webhooks, so `src/lib/local/repo-watch.ts` (started by the scheduler, also in GitHub-only mode, never under vitest) watches them while a browser tab is open and visible (`pollMode() === "active"`); when idle it does nothing and the 15-minute `reconcile.all` stays the safety net. Per repository it sends two conditional requests through the profile's own `gh` (`GET issues?state=all&sort=updated&direction=desc&per_page=1` and `GET commits?per_page=1`) with the ETag of the previous answer. These are the intended signals: issues include pull requests (a review bumps their `updated_at`) and the commits are those of the default branch; releases, tags and other branches wait for the 15-minute cycle. The first answer only records the ETag; a 304 (which `gh api -i` prints on stdout with exit code 1) costs no rate limit and does nothing; a different ETag requests an incremental refresh (`requestRepositoryRefresh(db, id, { full: false })`, the same `sync.repository` job and dedupe as the Refresh button, which stays full and is never downgraded by a merged request), at most once per repository every 30 s and with at most 2 watcher-triggered refresh jobs queued or running. A change that could not be enqueued, or that arrived inside the gap or above the cap, stays pending and is sent at a later probe. Probes are spread evenly (one repository every interval / repositories, +-20% jitter), at most 2 in flight. A failing repository backs off exponentially up to 10 minutes; a rate limit (403/429 with `x-ratelimit-remaining: 0` or `retry-after`) pauses the whole watcher for at least 60 s counted on this computer's clock (never only until the absolute reset time) and also counts as a failure of that repository. ETag baselines and pending changes are kept for every eligible repository, also those currently outside the cap.

Which repositories: active, non-demo repositories that are not covered. A repository counts as covered only while the hub's webhooks are enabled: the live link stores `webhooks.enabled` from `me()` in DiscoveryCache under `github-app-hub-webhooks` (cleared by leaving the team and by Turn off), and the watcher excludes the ids of `readAllCoverage` only if that flag is true, without any request to the hub. In GitHub-only mode nothing is covered. If the coverage cannot be read, the cycle is skipped (or the last known set is kept); an unreadable database never means "nothing is covered".

Settings, per profile (Settings page, "Auto-sync of repositories"; columns `watchEnabled`, `watchSeconds`, `watchMaxRepos` of `TeamConfig`): a switch, the interval in seconds (2 to 300, default 15) and the number of repositories (1 to 200, default 20; the least recently synced first). **The switch is on by default**: the feature is on unless turned off, and turning it off leaves only the 15-minute cycle. A NULL number column means "not saved here", and then the environment applies: `MERGEPORT_WATCH_SECONDS` (integer 2 to 300) and `MERGEPORT_WATCH_MAX_REPOS` (integer 1 to 200); invalid values mean 15 and 20. Precedence: saved value, else environment, else default. A blank field on the page clears the saved value (writes NULL), the page says when the value in use comes from the environment, and a save writes only the fields that changed. The watcher re-reads all of it at the start of every cycle, so a change applies within one interval; a `start()` after `stop()` can never leave two loops (a generation counter). Request budget: total probe requests stay at or below 300 per minute (GitHub's secondary limit is about 900 per minute and every probe spawns a `gh` process), so the effective interval is `max(configured, repositories * 2 * 0.2)` seconds: 3 repositories can run every 2 s, 20 settle at 8 s, 200 at 80 s. The Settings page shows the effective value and says when the budget stretched it; the Repositories page shows "Auto-sync ~N s" (N effective) on watched repositories that are not Instant.

## Daily digest

Each local day Mergeport writes the person a digest of the previous day: what was done, what was left undone, what needs them, and what is waiting on other people. It is deterministic and local: built by `src/lib/services/digest.ts` from the local database only, with no model, no network call, no new secret and no write to GitHub, and with the same viewer scoping as every other page (`repoWhere`/`planningWhere`; a repository the person cannot see contributes no entry, count or title). Sources: tasks that moved to done (`PlanEvent`), pull requests merged and issues closed that were authored by or assigned to the person, reviews they gave, backports marked done (both sides of the fork mapping visible); open assigned items, their own open pull requests, overdue or ended-iteration tasks and unsent `ReviewDraft` comments; the `attention()` queues, failing checks and conflicts on their pull requests, unread inbox, open sync conflicts and hub restores, repositories with a sync error or disconnected; manual waiting records and review requests older than 2 days that the reviewer has not answered (with who). Each section keeps 15 entries plus a "more" count. The day is a local calendar date (`src/lib/domain/digest.ts`): the window is `[start of the day, start of the next)` computed from the zone's own offsets, so it is 23 or 25 hours on a daylight-saving change.

**Extension point.** `registerDigestSource(name, fn)` (or the `sources` option of `buildDigest`) adds entries per section (`done`, `undone`, `mine`, `others`); a source is responsible for scoping its entries to the viewer, and one that throws is skipped. The upstream auto-updater uses it to report an update that ran, failed or needs the person.

**Storage and schedule.** `DailyDigest` holds one row per person and reported day (`@@unique([userId, day])`, JSON payload, `readAt`); it is personal, never synchronised and not part of the backup. The recurring job `digest.daily` (every 10 minutes, `ensureRecurring` in the scheduler tick, handler in `handlers.ts`) calls `runDailyDigest`: once the configured hour (default 08:00, local) has passed and the previous day has no digest, it generates one. A job that is due after the app was closed runs on the first tick after start, so a missed hour is caught up; the unique row makes a second generation impossible, and only the Regenerate button replaces a digest (it creates no second notification). A new digest also creates one `Notification` (kind `daily-digest`, link `/digest?day=...`), subject to the person's in-app preference for that kind. Settings (switch and hour) live in the personal notification preferences (`NotificationPref.prefs.digest`) and are edited under Settings, "Daily digest". Pages: `/digest` (stored days, older/newer, Regenerate, Mark read), a card on Overview and a sidebar entry with the unread count. Demo mode has no scheduler, so its first digest is made on demand from the demo data.

## Upstream auto-update

An opt-in, per-mapping updater for forks (`src/lib/local/upstream-updater.ts`, settings and history on the Forks page). Its idea comes from a server-side updater that promotes only upstream commits that build and pass tests; this version has no servers, containers or GPUs, just git, an optional command and a pull request.

**Flow.** After `sync.fork` finds the fork behind, and only when the mapping has auto-update on, the job `upstream.update` (deduplicated as `upstream:<mappingId>`) asks for a run. The job returns at once; the run lives in a process-wide queue with **one run at a time** across all mappings, so a 20-minute check never stalls the job worker. The run: (1) clone or reuse `<MERGEPORT_HOME>/updater/<mappingId>/repo` (a damaged clone is replaced), fetch the fork (`origin`) and upstream; (2) candidates are the newest upstream commit and up to `MAX_BACK = 6` older first-parent commits, never past what the fork contains; (3) per candidate: reset `mergeport/upstream-sync` to the fork branch, `git merge --no-ff` with a fixed message; a conflict is aborted, its files recorded, nothing is resolved; (4) run the verify command if there is one; (5) promote. Between steps upstream is fetched again: a newer head restarts the attempt on it (at most 3 times); a running check is never killed except by its time limit, which also ends the run (older commits are not tried after a timeout). A conflict or failed check moves on to the next older commit; all failing ends as `conflict` (all conflicts) or `verify-failed`. Turning auto-update off cancels a run between steps.

**Promotion.** `pr` (default): push `mergeport/upstream-sync` to the fork with `--force-with-lease` naming the value seen at fetch (so someone else's change to that branch is never overwritten), then `GithubPort.openOrUpdatePull` lists open pull requests for that head and base and edits the one it finds or creates one. Never merges or closes it. With no verify command the run is `merged-untested`, the pull request says so, and `push` is refused (at save and again at run time). `push`: only after the check passed, a plain `git push origin sync:forkBranch` (a fast-forward; git refuses otherwise, never forced).

**What runs, where.** Only inside the updater folder. `src/lib/local/git-write.ts` is the single writer (`git.ts` stays read-only): argument arrays and `shell: false`; an allow-list of `clone, fetch, checkout, switch, reset, merge, merge-base, rev-list, log, rev-parse, status, push, branch, remote, config, diff --name-only`, each with its own rules (no branch deletion or rename, push only to `origin` with one explicit `refs/heads/X:refs/heads/Y` whose destination is the sync branch or, in push mode, the fork branch, never `--force`, `--delete`, `--mirror`, `--all`, `--tags`; only a few config keys; no options that run a program or write elsewhere); `cwd` must resolve (realpath) inside the updater folder; a scrubbed environment; timeouts and output caps; URL credentials are redacted from logs and errors. **Credentials**: network calls use `-c credential.helper=` then the GitHub CLI's helper (`gh auth git-credential`), so Mergeport never reads, stores or logs a token. Before each network call it checks that the account the CLI has selected is the profile's account (numeric id) and refuses otherwise; that check cannot be atomic with git's own credential request, so a `gh auth switch` inside that fraction of a second is the one window left. The verify command is split by a quote-aware splitter (`splitCommand`: no expansion, `;|&><$*` are ordinary characters) and run with `shell: false`, cwd the clone, environment `PATH`, `SYSTEMROOT`, `HOME`/`USERPROFILE` and `CI=1` only, a time limit (default 20 min, 10 s to 2 h), the process tree killed on timeout, and a capped log. On Windows `npm`/`npx` are mapped to node's own scripts; other `.cmd` tools cannot run without a shell and are refused with a message.

**The command is local.** `UpstreamUpdateConfig` (command, mode, limit, branch name) lives only in the profile database. It is not a synced entity (a mapping that arrives from a teammate has auto-update off), not in the hub, and not in a backup: the table is absent from `backup.ts`, and a crafted file that names it or the column is ignored on restore. Only an administrator of the profile can change it.

**Reporting.** `UpstreamUpdateRun` rows (state, tried commits, upstream commit review, conflict files, pull request URL, log tail; the full logs stay under `updater/<mapping>/logs/`). Notable outcomes (pull request opened, fork updated, conflict, failed check, failure) create an in-app `Notification` of kind `upstream-update` for the profile's administrators, unless their stored preference turns it off (the kind is not in the Settings list yet). `up-to-date` is recorded once per upstream commit and never notifies; a run left `running` by a closed app is marked `cancelled` on the next start. `upstreamUpdateAttention(db, viewer, { since })` returns the latest settled run per mapping that needs a person, plus unseen release warnings (below); the daily digest's `upstreamUpdateSource` lists them under "needs me".

**Release watch mode ("warn about upstream releases only").** `UpstreamUpdateConfig.mode` is `merge` (everything above, the default for every existing row) or `releases`. In `releases` mode Mergeport does no git at all: no clone, fetch, merge, push, pull request or verify command, and the verify command, promote mode, time limit and sync branch are ignored (`cleanSettings` in `src/lib/domain/upstream-update.ts` validates per mode, so `push` needs a verify command only in `merge` mode; switching mode writes none of them, so the stored values return when the person switches back). The code lives in `src/lib/services/upstream-releases.ts`, which imports nothing from `git-write` or `verify-run` (a test makes both throw and runs the whole flow); `runUpdate` and `maybeRequestUpdate` return early for a `releases` mapping.
- *Detection.* `GithubPort.listReleases(owner, repo, { etag })` reads one page (30) of the upstream's releases with a conditional request; an unchanged list is a 304 (`not-modified`, no rate-limit cost, nothing created) and the ETag is kept on the config. The job `upstream.releases` (deduplicated `upstream-releases:<mappingId>`, handler in `handlers.ts` behind `guardSourceBudget`) is requested after `sync.fork` and by the 15-minute `reconcile.all`, so a fork that is not behind is checked too. At most one check per mapping per about 15 minutes (`RELEASE_CHECK_MIN_MS` = 14 minutes, so the cycle is never skipped by jitter), enforced when asking and again when running; "Check now" skips the cap (the ETag keeps it cheap). A failed read throws for the job to retry with backoff; a manual check records a `failed` row instead.
- *Baseline and warnings.* The first check after the mode is switched on (or after `includePrereleases` changes, which re-baselines) only records the newest release (`lastReleaseId/Tag/At`, `releasesBaselined`); it warns about nothing. After that, each release published after the cursor and not warned before (`UpstreamUpdateRun.releaseId` is remembered, so a release is never announced twice) becomes one `release-found` run (`release` JSON: id, tag, name, link, published time, a 600-character plain-text excerpt of the notes, whether the fork's branch already contains the tag, and a "+N more" count) and one `Notification` (kind `upstream-release`, the same preference as `upstream-update`). Drafts are never considered, prereleases only with `includePrereleases`; at most 5 warnings per check (the newest 5), the rest counted. "Contains the tag" is one `isAncestor` compare call per warned release; anything but a clear answer is stored as unknown and nothing is said. Release text is untrusted: stored as text, rendered as text, and the link is kept only if it is http(s) on the configured host inside the upstream repository (checked when stored and again when read).
- *Digest.* A `release-found` run is "unseen" until `seenAt` is set, which happens when an administrator opens the Forks page (`markReleasesSeenAction`, called once from a client effect; the section is visible on that page). The digest lists each unseen warning from the last 14 days under "needs me" (reason "New upstream release v1.2.3"); it drops out when seen or after 14 days, and a later merge run does not hide it.
- *Local only.* The cursor columns sit on the same local-only config table: not synced, not in a backup.

**Limits.** The check command is arbitrary code from the merged upstream, run as you: only configure it for upstreams you trust. Runs happen only while Mergeport is open. Untracked files a check leaves in the private clone are not cleaned between candidates. Real GitHub was not exercised; tests use real git against temporary bare repositories and the in-memory GitHub fakes.

## Authorization of local data

`src/lib/authz/viewer.ts` is the single place visibility is defined. `repoWhere(viewer)` is a SQL filter evaluated per request, not a cached list. Locally a person always has full capabilities over what they track; for repositories that arrived through a space, access derives from that space's membership. Missing and hidden both produce the same `NotFoundError`; `ForbiddenError` is used only when the item is visible and the capability is not. Planning cards linked to a GitHub item inherit that repository's visibility; a hidden blocker still blocks and appears as an opaque marker.

## Agents

AI apps reach Mergeport through the hosted MCP endpoint (`src/lib/mcp`, `POST /api/mcp`, personal access tokens and OAuth; see `docs/mcp.md`). The task commands it runs live in `src/lib/cli/mp.ts`. The old `npm run mp` command line and the stdio MCP server read a local profile database, and were removed with the local launcher.

## Local worktrees

Read-only, on this computer only. Folders are mapped explicitly; scans run a fixed allow-list of read-only `git` subcommands as argument arrays (no shell, no hooks); only branch names, paths and counts of changed files are kept, never contents or diffs. Snapshots stay in the local database and are never written to an outbox or a space. Sharing worktree data with teammates is not implemented.

## Review waiting

`src/lib/domain/review.ts` derives the waiting state from real review requests and review results plus the resolved routing rule. A comment or a label change never counts as approval. Approvals on an older commit are stale. GitHub's requested-reviewers endpoint has no timestamp, so "waiting since" is when Mergeport first saw the request (labelled "request first seen").

## Theme and motion

See `DESIGN.md` ("Dark theme", "Motion") and `docs/motion.md` (motion matrix, tokens, ownership rules, evidence, reference ledger). The theme is a cookie rendered into `<html data-theme>` on the server; tokens are defined once and overridden for dark.

## Limitations (stated, not hidden)

- Eventual consistency by polling; the delay is published, not eliminated.
- Git history in a coordination repository keeps everything ever written there. Revocation stops access and removes local cache; it cannot rewrite what a former collaborator already read.
- A repository belongs to one audience (one space) at a time, and a project shared through a space may only link repositories shared through that same space.
- Candidate trust is as strong as GitHub's owner, visibility and permission data plus the manifest checks. For an organization-owned space the manifest's creator can be any member who can create repositories there; the card shows who created it and warns when it is not the team owner, but Mergeport cannot prove more than that.
- Reading a token: Mergeport must read the profile's token from `gh` into memory to bind calls to the account. It is never stored, logged, put in an argument, or sent to the browser, but it is in the server process's memory and in each `gh` child's environment while a call runs.
- Two live GitHub calls can still be awaited while a page renders, both user-initiated and both capped at 12 seconds: reviewing a team plan and opening a join link. Everything else renders from saved state.
- Forced termination (End task, `taskkill /F`, a crash, power loss) cannot run cleanup code, so graceful cleanup cannot be guaranteed after it. Ctrl+C can, and was exercised. After a forced kill SQLite stayed consistent and unsent edits were intact; an interrupted refresh is marked on the next start.
- Background sync runs only while the app is running.
- `repo` is a broad GitHub scope; see `docs/github-cli-setup.md`.
- Real GitHub was exercised only read-only (see below). SSO, throttling, invitations and every write remain simulated.

## Verification record

Run on 29 Oct 2026, Windows 11, Node 24.12, `gh` 2.102.0 with one existing signed-in account. Four categories, kept apart:

**Verified against real GitHub (read-only, through the application's own pinned-identity adapter; `npm run test:live`, opt-in).** Nothing was written, no repository or invitation was created, the selected `gh` account was not switched, no login was started, and no private repository was inspected beyond being counted by discovery (names are not printed or stored).

| Check | Result |
| --- | --- |
| Pinned identity | `GET /user` through the bound runner returned the profile's numeric id; a profile pinned to a different id was blocked (`mismatch`, 401) with nothing sent |
| Public repository `cli/cli` | metadata, 100 issues and pull requests (page 1), 32 pull requests, reviews on 13 of the first 15 pull requests (23 reviews), pull request detail, 259 branches |
| Discovery | the account's repositories listed (68: 20 public, 48 private), on one page |
| Pagination | `rel="next"` followed across 3 real pages, 300 unique items |
| Rate limit | real `x-ratelimit-limit/remaining/reset/resource/used` headers present (core, limit 5000); the adapter records them |
| Conditional request | `If-None-Match` with the real ETag returned 304 through `gh` |
| Errors | missing repository and missing pull request map to `not-found` |
| Launched copy | an isolated copy launched with the documented command against this account (temporary profile home): page rendered in 70 ms, background discovery completed ("Up to date", 68 repositories), Settings showed "Signed in with the GitHub CLI" |

**Verified locally (real processes, browser, files on this machine).**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit`, `npx eslint .`, `npm run build` | all clean after the last edit (build: no warnings) |
| Unit and integration suite (`npm test`, which is `vitest run --maxWorkers=4`) | passed when this record was written (29 Oct 2026); the file and test counts change with every commit, so run the command for the current numbers (not re-verified here). The live tests in `tests/live` are skipped unless `MERGEPORT_LIVE=1` |
| Reproducible install | isolated copy without `.env`, databases, `node_modules`, `.next` or `src/generated`: `npm ci` in 16 s (659 packages), one `better-sqlite3` 13.0.3 loaded from its shipped `prebuilds/win32-x64.node`, production build clean, `npm run local` built on first run and served |
| Ctrl+C through the real Windows console (`npm run local`, hidden console, `GenerateConsoleCtrlEvent`) | idle: server and children gone, port released; with discovery stalled and a hung `gh` child running: the hung child and the whole tree gone; only npm's `cmd.exe` batch wrapper waiting on "Terminate batch job (Y/N)?", which was ended by the test (only its own process) |
| After shutdown | `PRAGMA integrity_check` = ok, the pending outbox edit still `PENDING`, restart served in 63 ms, an interrupted refresh was recovered and completed |
| Forced kill of the launcher process | no processes were left in this run, SQLite integrity ok, outbox intact, discovery row left `RETRYING` (recovered on the next start). This does not show cleanup is guaranteed |
| Account binding, subprocess handling, offline behavior, joining, concurrent migrations | as listed in the test table below (real child processes against a fake `gh`) |

**Verified with mocks (labelled simulated).** A fake `gh` script and an in-process GitHub simulation stood in for: multi-account switching and credential revocation, SAML SSO, throttling and `Retry-After`, invitations and collaborator permissions, repository deletion and recreation, newer-schema spaces, and every write.

**Still unverified or blocked.** Any write to GitHub; a private repository (needs your explicit selection); real SSO, throttling, invitations and a real second account; multi-page discovery for an account with more than 100 repositories (the real list fit on one page; paging itself was proven on a different endpoint); `gh auth login` on Windows (never started automatically); macOS and Linux; touch devices; screen readers.

Earlier round (local-first build, light and dark, motion): a read-only adversarial review confirmed and a regression test now covers: tombstones or files from one space deleting or renaming an entity in another; a project in a wider space publishing a narrower space's repository and issue titles; a malformed file stalling sync; an open conflict silently settled; a newer-schema file overwritten; forged or replaced manifests; stale permission checks; quarantined edits re-captured; and the Postgres importer carrying hidden content. An interface, accessibility and motion review repaired the drag handle semantics, focus after a Move, live-region roles, the tab pill, refresh storms, an in-shell error boundary and a bounded Team page. Browser testing found a launcher redirect that dropped the session cookie and a missing sign-out route.

This round's defects (found by testing, not only by reading) were:

1. Writes could run as the newly selected account for up to the identity cache window (now bound to the profile's account).
2. Discovery auto-joined matching private repositories (now candidates plus an explicit confirmed Join, with owner, team, manifest and repository-id checks).
3. The Team and Connect pages waited on `gh` (now rendered from saved state with background refresh).
4. Migrations raced when several processes started at once (now one transaction per migration, re-checked after the lock).
5. A dead transport surfaced through Octokit as a generic error and any `TypeError` was shown as "offline" (now only real fetch failures are offline; bugs are errors).
6. The identity check spawned `gh` every five seconds (removed).

Real-account read-only verification and the defects it found are in `docs/real-github-verification.md`. Not verified, and not claimed: invitation behaviour, SSO, org policy and a real multi-account `gh auth switch`; `gh auth login` on Windows; the launcher's Ctrl+C path; touch devices; screen readers.

Test files:

| File | Covers |
| --- | --- |
| `tests/scheduler.test.ts` | Recurrence over 3 cycles with fake time, resume, crash/restart, duplicate scheduling, concurrent workers |
| `tests/team-sync.test.ts` | Two isolated clients with separate databases against a simulated GitHub: live propagation, concurrent and same-record edits, duplicate retries, offline and reconnect, deletion, restart, schema mismatch, revoked access, rate-limit exhaustion, owner global view vs two members, privacy of the common repository, forged roles, mocked create/invite/join |
| `tests/access.test.ts`, `tests/actions.test.ts` | Viewer-scoped visibility, forged ids, revocation, GitHub write capabilities, sessions, redirects |
| `tests/local-features.test.ts` | Planning concurrency, manual waiting, worktree scan privacy and cleanup |
| `tests/gh.test.ts`, `tests/local-guard.test.ts` | `gh` transport and identity, loopback guard, theme preference |
| `tests/identity-binding.test.ts` | Account switches before, during and between queueing and retry; credentials out of arguments; inherited tokens; offline vs blocked |
| `tests/gh-process.test.ts` | Real subprocess behaviour: arguments, stdin, timeout, cancel, tree kill, shutdown, discovery, real `gh --version` |
| `tests/discovery.test.ts` | Saved-list rendering, offline/rate-limit/auth states, retry and backoff, dedupe, shutdown, restart recovery, transport classification |
| `tests/join-consent.test.ts` | Candidates, explicit confirmed join, trust rules, forged and look-alike spaces, replaced repositories |
| `tests/migrations-concurrent.test.ts` | Twelve processes migrating one database at once |
| `tests/review-fixes.test.ts` | Cross-space tombstones and file takeover, poisoned files, wrong-repository manifests, conflicts that must stay open, newer-schema files, quarantine, shared-audience linking |
| `tests/migration.test.ts` | Postgres import: visibility, no credentials, no sharing, rebuilt indexes |
| `tests/sync.test.ts`, `tests/connector.test.ts`, `tests/domain/*` | Source sync idempotency, git access, review/planning/fork logic |
