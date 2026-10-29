# Audit coverage ledger

Source: the audit of commit `51efcb3` (12 findings, 32 ideas, 5 follow-up questions). This file records what is done, how it was verified, and what is left. It is the continuation point: resume from the first row that is not "done".

Verification state at the last commit: `tsc --noEmit` clean, `eslint .` clean, `vitest run` 457 passed / 5 skipped (live GitHub tests are skipped by design), `npm run build` succeeded, each phase checked in the rendered demo. Nothing was run against real GitHub.

## Phase 1 findings

| # | Finding | Status | Fix | Regression test |
| --- | --- | --- | --- | --- |
| B01 | Task detail leaks hidden dependency ids/titles | done | `getTask` uses scoped `listDependencies`; page renders opaque markers | `tests/access.test.ts` (both directions) |
| B02 | PR diff cache ignores base | done | cache key carries `baseRef` and format version 2 (files, commits) | `tests/git-view.test.ts` (retarget at same head) |
| B03 | Commit files stop after 100 | done | follows pages up to 30; `truncated` only when pages remain; cache version 2 | `tests/sync.test.ts` (3 pages, 220 files) |
| B04 | Legacy commit statuses ignored | done | combines check runs (paginated) with combined status; unreadable stays UNKNOWN | `tests/sync.test.ts` (4 cases + UNKNOWN) |
| B05 | Targeted issue refresh reads page 1 only | done | new `getIssue` on the port (octokit, fake, demo) | `tests/sync.test.ts` (issue on page 2) |
| B06 | Deleted GitHub comments linger | done | reconcile after a complete fetch; skipped at the 3000 paging cap and on any failed sync | `tests/sync.test.ts` |
| B07 | Assignee match is case-sensitive | done | logins stored and queried lower-case; migration `20261101100000_login_case` backfills | `tests/tasks.test.ts` |
| B08 | Checklist paste half-saves | done | validate all lines, then one transaction | `tests/tasks.test.ts` |
| B09 | Job completion can lose an enqueue | done | completion and enqueue writes are conditional on the state they read | `tests/scheduler.test.ts` (injected interleaving) |
| B10 | Transfer keeps old owner | done | refresh moves owner, url and name together; REMOVED guard kept | `tests/sync.test.ts` (2 cases) |
| B11 | Leaving a team loses admin | done | leave restores ADMIN; profile init repairs personal mode | `tests/revoke-space.test.ts` |
| B12 | Dependencies absent from PR attention | done | `loadRuleContext` supplies unfinished blocker counts; project-scoped views count that project's links | `tests/access.test.ts` |

Not independently checked: that each new test fails on the old code (B01 and B09 were written against the old behaviour in mind; B10-B12 rely on the audit's reproduction).

Compatibility: B07 lower-cases assignee spelling (display spelling is not kept). Older clients that sync mixed-case logins are re-normalised on import. A backup of the profile database was taken before the migration: `~/.mergeport/profiles/*/mergeport.db.pre-audit.bak`.

## Follow-up questions

| Question | Status | Finding |
| --- | --- | --- |
| Browser PR cache when head changes | fixed in source, not browser-verified | `PrTabs` keys its cached responses by `?v=<head>:<base>`; `WorkItemDetail` supplies it. Needs a rendered check while a head changes |
| Deferred coordination entities after a 304 | fixed | Confirmed: an entity whose source repository was not synchronised yet waited for the next head change. `Space.deferredCount` (migration `20261101110000`) makes an unchanged head get re-read while entities are deferred. Test fails without the fix: `tests/deferred-sync.test.ts` |
| Shared GitHub quota / scheduler starvation | partly: the Sync page now shows the account's remaining request budget; scheduler starvation not measured | |
| Invitation permissions, personal vs organisation | not investigated (needs a real, approved account) | |
| Crash recovery around SENT outbox operations | fixed: confirmed that an operation orphaned in SENT by a crash was never retried; now recovered after 2 minutes and sent exactly once (the entity file records the operation id); `tests/crash-recovery.test.ts` | |

## Ideas 1-32

All 32 are implemented to the extent stated per row; every row also lists what is not done. Existing pieces (Attention queues, waiting rules, saved filters, planning columns, fork triage, the worktree snapshot, the Sync page) were reused and verified rather than counted as done.

| # | Idea | Status |
| --- | --- | --- |
| 1 | Actionable inbox | done (personal done / unread / snooze, reopens on a new commit, comment or review request; `/inbox`, sidebar count; `tests/inbox.test.ts`; checked in the rendered demo, dark and light). Not done: reopening on a new check result is deliberately excluded; no mobile-width pass; Activity events are not yet inbox inputs |
| 2 | Staged waiting | done (stage on waiting rules and manual records: internal review, external review, maintainer merge, upstream release; derived with owner, reason, age and next action; approval does not satisfy a maintainer-merge stage; shown on attention rows and PR detail; `tests/domain/stages.test.ts`, `tests/inbox.test.ts`; checked in the rendered demo). Not done: stages are not yet a filter/queue of their own; older clients drop `stage` if they edit and re-push a rule (no entity schema bump) |
| 3 | PR readiness panel | done ("Ready to merge?" on PR detail: head, reviews, stale approvals, checks, conflicts, planning dependencies, discussions; each row labelled GitHub fact / dashboard advice / not known; next responsible person; `tests/domain/readiness.test.ts`; rendered check). Not done: unresolved review threads are shown as "unknown" because resolution is not synchronised; required-vs-optional checks are not read (labelled as such) |
| 4 | Shared views | done (one saved-view bar on Attention, Tasks, Planning, Forks, PRs and Issues: filters, grouping and sort are the query; optional sharing as a definition-only synced entity `view`; results computed under each viewer's access; `tests/views.test.ts`; rendered check). Not done: PR/issue lists still also have their older filter UI; density/visible-column choices are only saved if the page puts them in its query |
| 5 | Persistent scope | done (Global / Project / Repository in the top bar, cookie-persisted, validated against what the viewer can see; narrows Attention, nav counts, Overview, Tasks, Planning, PR and issue lists; page note says what it is narrowed to; `tests/scope.test.ts`; rendered check). Not done: Activity, Forks and Branches ignore the scope; the Radix picker was not driven with the mouse in my browser check (cookie path was) |
| 6 | Since I last looked | done for PR/issue detail (personal baseline on first look, lists new commits, comments from others, reviewer decisions, checks, conflicts, state, title until "Mark as seen"; `tests/seen.test.ts`; rendered check). Not done: no per-file "changed files" detail, not shown in lists or Inbox rows |
| 7 | Review capacity | done (`/capacity`: queued reviews and oldest wait per member, availability windows and configured backups as shared synced entity `availability`, suggestion only, no reassignment or notification; `tests/capacity.test.ts`; rendered check). Not done: capacity ignores team-review routing (only named users) |
| 8 | Notification preferences | done (Settings: per-event in-app and desktop, quiet hours across midnight in the person's time zone; new "changes requested" notification; grouped on Activity; desktop pop-ups only while the app is open and only if the browser allowed them; `tests/notify.test.ts`). Not done: desktop pop-ups were not exercised in a real browser, and only two event kinds exist |
| 9 | Named boards, WIP limits | done (`PlanBoard`: columns subset/order/labels per project column, four templates, WIP limits as flagged advice; synced entity `board`; `tests/planning3.test.ts`, `tests/domain/planning3.test.ts`; rendered check). Not done: boards cannot add new column keys beyond the six project columns |
| 10 | Swimlanes | done (group by repository, assignee, milestone or epic; same cards, one board per lane; compact/comfortable density). Not done: dragging between lanes does not change the lane value; quick filters beyond saved views |
| 11 | Epics | done (one level, owner, dates, decisions, progress over visible children with hidden count; synced entity `epic`; Epics view). Not done: epics are not shown in the task detail page yet (only in cards, lanes and the Epics view) |
| 12 | Release readiness | done (Release view: unfinished, failing CI, blocked, pending decisions; work finished and shipped are separate; admin records tag and https link). Not done: no GitHub Releases are read, shipped is recorded by hand (unverified against real GitHub) |
| 13 | Iterations | done (non-overlapping timeboxes, explicit carry-over on close with recorded events; synced entity `iteration`). Not done: no per-iteration burndown (analytics only from recorded events) |
| 14 | Dependency map | done (kinds blocks/related/duplicates; cross-project within one audience; workspace-wide cycle check; layered SVG map, critical blockers, hidden ends as anonymous markers; closed-unmerged PR keeps blocking in planning, attention and release readiness). Not done: map has no pan/zoom or filters |
| 15 | Planning automation | done (per-project off/suggest; merged PR or closed issue previews a move to Done; applying moves the local card only; a PR closed unmerged is never suggested). Not done: only one rule exists |
| 16 | Templates, promotion | done (bug, feature, review, release templates with checklists; promote a task: destination choice, exact preview, one issue created as the person, same record linked, never twice; tested against the fake port). Not done: promotion not exercised against real GitHub |
| 17 | Delivery analytics | done (append-only `PlanEvent` recorded on create, move, milestone, epic, iteration, carry-over; synced entity `planevent`; cycle time, aging WIP, review wait from real review facts, scope added; says since when recording began and what is left out). Not done: events before this release do not exist, so history starts at upgrade |
| 18 | Detail drawer | done (`?card=<id>` side drawer from board cards and the Tasks list; keeps filters, scroll and focus; same authorization as the task page; comment and checklist quick actions; open-full-page link). Not done: not wired into PR/issue lists or Attention rows |
| 19 | CODEOWNERS routing | done (parser/matcher with GitHub semantics, read from the PR base branch, routed over the changed files; shown beside existing reviewer sources; teams reported as membership-unknown; explicitly not a GitHub requirement; `tests/domain/phase4.test.ts`, `tests/phase4.test.ts`; rendered check shows the no-file case). Not done: not combined into the review derivation itself (kept separate on purpose); not verified against a real CODEOWNERS file on GitHub |
| 20 | Draft review batches and threads | done (personal `ReviewDraft`, "Add to review" in the diff, one submit request carrying all comments, stale drafts refused, drafts kept on failure; thread resolved flag synced via GraphQL and navigable with next/previous; resolve links to GitHub because REST cannot). Not done: the GraphQL read and batched review POST were tested against fakes only (unverified against real GitHub); no reply-in-thread from the dashboard
| 21 | Compare review versions | done (since my last review, or between two commits, via the compare API; viewed marks keyed by content signature so only changed files reset; comparison shown in a banner). Not done: approval does not yet display which comparison it was based on beyond the review commit already shown in Reviews
| 22 | Scoped label taxonomy | done (`family::value` parsing, global and per-repository spellings as synced `labelmap`, list filters expand a concept to all spellings, preview as counts, never rewrites labels; `/admin/labels`)
| 23 | Upstream subscriptions | done (shared `upstreamsub`: labels, paths, milestone, authors, title words; any hit selects, reasons shown, mute; path criteria use cached PR files and say "not checked" otherwise). Not done: path matching needs the PR files to have been opened once
| 24 | Backport/cherry-pick tracking | done (explicit `backport` records; evidence kinds kept apart: ancestry, possible patch equivalence, manual, not checked; local check runs read-only git in the mapped clone, tested with real temporary git repos; manual never overwrites verified evidence)
| 25 | Upstream adoption planner | done (preview, then milestone + one task per change + planned backport records + final sync task blocked by all of them; the existing fork sync stays the explicit last action). Not done: it does not run the sync itself
| 26 | Branch/worktree work links | done (PR by repo + head branch, task by shared branch name or its PR; facts only; copy path, open folder, open in editor restricted to this computer's recorded worktrees; paths never synced). Not verified: open folder/editor were not exercised
| 27 | Per-person access preview | done (before sending invitations: repositories by name, projects, local tasks, other record counts and kept history for the space, plus each invitee's separate permission on every named source repository via GitHub; unreadable = unknown, never none; `tests/access-preview.test.ts`). Not verified against real GitHub; the collaborator-permission endpoint needs push access to the source repository
| 28 | Explicit team switching | done as separate database contexts (`contexts.json` + one SQLite file per team in the profile folder; switch restarts the app under the launcher; the parked context keeps spaces, unsent edits and personal state; only the open one syncs). Verified end to end in the demo: created a context, switched, launcher reopened the other database, original untouched; `tests/contexts.test.ts`. Not done: no delete/archive of a context; switching outside the launcher needs a manual restart
| 29 | Sync centre | done ("Where your changes are": saved/queued/sending/published/waiting-for-teammates/held states per space, GitHub request budget from /rate_limit, next check, base-version column in the conflict diff; `tests/domain/sync-facts.test.ts`). Not done: per-source repository freshness detail beyond the existing tracked-repositories panel
| 30 | Backup and restore | done (versioned JSON of Mergeport-owned tables and unsent edits; no credentials, folder paths or GitHub-owned data; restore previews counts, remaps workspace/user/member and repositories by GitHub id, is additive, atomic and idempotent; Settings panel and same-origin POST routes; `tests/backup.test.ts`). Not done: restore of a backup into a profile for a different GitHub account is allowed (ids are remapped); cards linked to GitHub items are re-linked by the next sync rather than at restore
| 31 | Command palette and quick actions | done (Ctrl/Cmd+K: pages, scope, and /assign /priority /due /label /unlabel /move on the item in view, previewed in words with where each change is written; GitHub writes use the same functions and authorization as the buttons; `tests/quick-actions.test.ts`; palette opened in the rendered app). Not done: the existing bulk upstream triage was not changed
| 32 | Workflow UI refinement | partly done (keyboard: ? list, g-then-letter navigation, j/k rows; repository colour chips on Inbox and Attention; header action buttons aligned; Branches page no longer leaves its right side empty; diagonal stripes removed; the shared motion and theme tokens were reused). Not done: no full accessibility or performance audit, no mobile-width pass, repo chips not yet on every list

## Phase 2 progress

Phase 2 complete (ideas 1-8). Phase 3 complete (ideas 9-18). Phase 4 complete (ideas 19-26). Phase 5 complete as described (ideas 27-32). The inbox is built on the existing Attention queues (no second source of truth) and its state table `InboxState` is personal and never synced.

## What is left

1. Verify against real GitHub (read-only first): the GraphQL review-thread read, the batched review submission, collaborator permission checks, CODEOWNERS fetch, release links. Everything above was tested against fakes and local git only.
2. Invitation permissions for personal versus organization repositories (needs a disposable, approved target).
3. A real two-account acceptance test of sync, switching contexts and conflict recovery.
4. Accessibility and performance audits, a mobile-width pass, and wider use of the repository chips.

