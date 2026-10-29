# Verification against a real GitHub account (read-only)

Run on 2026-10-29 with `npm run local` (not demo mode) against one real personal account, signed in through the GitHub CLI (`gh` 2.102, one account, keyring storage, scopes `repo`, `read:org`, `gist`, `workflow`). Only reads were made. Every `gh` call went through a pass-through shim that logged the HTTP method: **0 non-GET requests** in the whole session. No comment, review, merge, label change, push, repository creation, invitation, team space or coordination repository was made.

## Identity and onboarding

| Check | Result |
| --- | --- |
| Pinned account | The launcher printed the account login and numeric id from `GET /user`; the profile folder is `github.com-<id>`; the overview greets that login. |
| Discovery vs. GitHub (`GET /user/repos`, same affiliations) | 68 of 68 repositories, 0 duplicates, 0 missing, visibility identical (48 private, 20 public). The account has fewer than 100 repositories, so a second discovery page was **not** exercised. |
| Ownership and capability | Owner type comes from GitHub's `owner.type` (35 personal private + 19 personal public + 14 organization). The connect page now shows owner kind (Personal / Other user / Organization) and the account's own permission (Admin, Maintain, Write, Triage, Read only; unknown stays "Access unknown"). Spot checks matched GitHub, for example a triage-only organization repository. |
| Discovery does not join or publish | Spaces list stayed empty; no non-GET call was made. |
| Tracking is local | Tracking 56 repositories wrote only to the local profile database (`Nothing was shared`). Three projects are local groupings with no space attached. |
| Public import | A public upstream was imported by `owner/repo` through the public API without a credential. |

## Content compared with GitHub

| Check | Result |
| --- | --- |
| Item counts, all 56 tracked repositories (GraphQL totals vs. local rows) | 56 of 56 equal after the repairs below (one live repository gained an item while testing and caught up on the next refresh). |
| Field level (type, title, state incl. merged, author, labels, assignees, URL, created time) | 0 differences over 3,200+ items in 10 repositories, including 1,130 items over 12 pages and a 227-item repository over 3 pages. |
| Conversation, reviews, requested reviewers for open items | Counts of conversation comments, reviews, review comments and requested reviewers matched for every open item compared (46, across 7 repositories). |
| Review queues | "Needs my review" = 6, the same six pull requests GitHub's own search returns for `review-requested`. |
| Checks and mergeability | `checks failing` and `blocked` on six pull requests; `conflicting` on four; `failing checks` on three: all matched GitHub's `mergeable_state` and check runs. |
| Fork and upstream | A real fork shows "Fork ahead: 17 commits upstream lacks, 0 missing", the same numbers as GitHub's compare endpoint, with both tips. |
| Unknown is not zero | Before the first sync a repository now reads "Open items unknown until the first sync" (it used to read "0 open items"); list pages say how many repositories have not been synchronized; old closed items whose conversation is not downloaded say so instead of "No comments". |

## Synchronization and recovery

| Check | Result |
| --- | --- |
| Progress in the top bar | A real "Syncing" state with running and waiting counts, a link to Sync, its description readable on keyboard focus (the previously unverified link variant). |
| Background updates | Job results, failures and queued refreshes now reach open pages within about 2 s (it previously needed a manual reload); scroll position and focus were preserved. |
| Manual and repeated refresh | A refresh is a complete listing; clicking it repeatedly coalesces into one job; unchanged closed conversations are not downloaded again. |
| Restart | The app was stopped and restarted several times mid-sync; a job left RUNNING by the dead process is not shown as progress and is reclaimed. |
| Network loss (simulated by a `gh` shim returning gh's own "error connecting to api.github.com") | Start-up with no network opens the single saved profile; pages render from the saved data; the top bar reads **Offline**; the connect list is kept and labelled "Offline: showing the saved list … last updated …, will retry …". |
| Rejected sign-in (shim returning gh's own HTTP 401 text) | Reads **Sign-in or access** with "no longer valid. Run: gh auth login …", on the connect page, the repository row and the top bar. Never mixed up with offline. |
| Reconnection | Sign-in/access → Reconnecting → Synced, live; 0 count mismatches and 0 duplicates afterwards. |
| Account pinning | Every call was preceded by a numeric-id verification (`GET /user`). With a single signed-in account `gh auth switch` could not be exercised for real; that is covered by the fake-`gh` tests only. |

## Defects found against real data, and repairs

1. **Pagination silently stopped after one page** when a cached page was answered `304 Not Modified` (GitHub sends no `Link` header on a 304). A repository looked "synchronized" with 255 of 1,130 items (another with 100 of 391). The cache now keeps the `Link` header; older cache entries are refetched in full. A manual refresh is a complete listing and a later light request never downgrades a queued full run.
2. **First sync spent the hourly request budget** on conversations of every old closed item (up to four requests each). Conversations are now downloaded for open items and for closed or merged items active in the last 14 days; others say "Conversation not downloaded". A repeated refresh does not re-download unchanged closed items. The whole 56-repository sync then took about 930 requests.
3. **Historical review requests became pending work and notifications**: 210 "active" requests and 23 "Review requested" notifications for merged or closed pull requests. Requests apply to open pull requests only; stale ones are closed and their unread notifications removed.
4. **No sync state at all in personal mode** (the top bar only knew team spaces). Added a source-refresh state (syncing, offline, sign-in or access, rate-limited, synced) with counts and a panel on the Sync page.
5. **Open pages did not update from background refreshes**; fixed by announcing finished jobs and queued refreshes on the existing event stream.
6. **Offline start was impossible**: the launcher and the launch link both required GitHub. They now open the one saved profile when GitHub is unreachable (never when signed out or refused), and a failed sign-in no longer consumes the one-time launch link.
7. **Missing information**: owner type and capability on the connect list, "unknown until first sync", unsynchronized notice on lists.
8. A leftover job from a killed process was counted as work in progress.

Each has a regression test (`tests/sync.test.ts`, `source-status.test.ts`, `repo-access.test.ts`, `discussion-window.test.ts`, `saved-profiles.test.ts`, `scheduler.test.ts`).

## Not verified

- Real network loss was **simulated** at the `gh` boundary, not by disconnecting the machine. Real SAML/SSO prompts, organization approval policies and GitHub-side rate-limit exhaustion were not reached.
- Discovery with more than 100 repositories (a second page).
- Reduced motion and a second browser were not re-run on real content; they were measured on synthetic data (`docs/motion.md`).
- Team collaboration with two accounts: nothing was created or sent. See `docs/team-test.md`.
- Dense review histories: the richest open item had 9 conversation comments; larger histories were not available.
- A repository of the owner kept changing during the run (live pushes), so the last item added there was only picked up by the next incremental refresh.
