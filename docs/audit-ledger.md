# Audit coverage ledger

Source: the audit of commit `51efcb3` (12 findings, 32 ideas, 5 follow-up questions). This file records what is done, how it was verified, and what is left. It is the continuation point: resume from the first row that is not "done".

Verification state at this commit: `tsc --noEmit` clean, `eslint .` clean, `vitest run` 326 passed / 5 skipped (live GitHub tests are skipped by design), `npm run build` succeeded. Nothing was run against real GitHub.

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
| Shared GitHub quota / scheduler starvation | not investigated | |
| Invitation permissions, personal vs organisation | not investigated (needs a real, approved account) | |
| Crash recovery around SENT outbox operations | not investigated | |

## Ideas 1-32

None of the 32 ideas has been implemented in this change. Existing pieces that a later phase can build on (not counted as done): Attention queues and waiting rules (1, 2), saved issue/PR filters (4), planning columns and milestones (9, 12), task checklists (16), fork triage and ack (23-25), worktree snapshot (26), Sync page (29).

| # | Idea | Status |
| --- | --- | --- |
| 1 | Actionable inbox | done (personal done / unread / snooze, reopens on a new commit, comment or review request; `/inbox`, sidebar count; `tests/inbox.test.ts`; checked in the rendered demo, dark and light). Not done: reopening on a new check result is deliberately excluded; no mobile-width pass; Activity events are not yet inbox inputs |
| 2 | Staged waiting | done (stage on waiting rules and manual records: internal review, external review, maintainer merge, upstream release; derived with owner, reason, age and next action; approval does not satisfy a maintainer-merge stage; shown on attention rows and PR detail; `tests/domain/stages.test.ts`, `tests/inbox.test.ts`; checked in the rendered demo). Not done: stages are not yet a filter/queue of their own; older clients drop `stage` if they edit and re-push a rule (no entity schema bump) |
| 3 | PR readiness panel | done ("Ready to merge?" on PR detail: head, reviews, stale approvals, checks, conflicts, planning dependencies, discussions; each row labelled GitHub fact / dashboard advice / not known; next responsible person; `tests/domain/readiness.test.ts`; rendered check). Not done: unresolved review threads are shown as "unknown" because resolution is not synchronised; required-vs-optional checks are not read (labelled as such) |
| 4 | Shared views | not started |
| 5 | Persistent scope | not started |
| 6 | Since I last looked | done for PR/issue detail (personal baseline on first look, lists new commits, comments from others, reviewer decisions, checks, conflicts, state, title until "Mark as seen"; `tests/seen.test.ts`; rendered check). Not done: no per-file "changed files" detail, not shown in lists or Inbox rows |
| 7 | Review capacity | not started |
| 8 | Notification preferences | not started |
| 9 | Named boards, WIP limits | not started |
| 10 | Swimlanes | not started |
| 11 | Epics | not started |
| 12 | Release readiness | not started |
| 13 | Iterations | not started |
| 14 | Dependency map | not started |
| 15 | Planning automation | not started |
| 16 | Templates, promotion | not started |
| 17 | Delivery analytics (start recording events first) | not started |
| 18 | Detail drawer | not started |
| 19 | CODEOWNERS routing | not started |
| 20 | Draft review batches | not started |
| 21 | Review version compare | not started |
| 22 | Scoped labels | not started |
| 23 | Upstream subscriptions | not started |
| 24 | Backport tracking | not started |
| 25 | Adoption planner | not started |
| 26 | Branch/worktree links | not started |
| 27 | Access preview | not started |
| 28 | Team switching | not started |
| 29 | Sync centre | not started |
| 30 | Backup/restore | not started |
| 31 | Command palette | not started |
| 32 | UI refinement | not started |

## Phase 2 progress

Ideas 1, 2, 3 and 6 done. Ideas 4, 5, 7, 8 not started. The inbox is built on the existing Attention queues (no second source of truth) and its state table `InboxState` is personal and never synced.

## Suggested order for the next session

1. Finish Phase 2: 4 (shared views), 5 (persistent scope), 7 (review capacity), 8 (notification preferences).
2. Crash recovery around SENT outbox operations; quota/scheduler investigation.
3. Idea 17's event capture can be added early and cheaply so history accumulates while other work proceeds.
