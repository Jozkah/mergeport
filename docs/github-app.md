# GitHub App (hosted)

A hosted Mergeport deployment talks to GitHub through ONE GitHub App, registered by the operator. Workspaces connect by installing the
App on their GitHub account or organisation; Mergeport then acts through short-lived installation tokens instead of any credential of the server's own. See `docs/tenancy.md` for how installations map to workspaces, and `docs/deploy.md` for running the web and worker services (container, proxy, health check) these variables belong to.

## What exists now, and what comes later

| Part | Status |
| --- | --- |
| Binding and state helpers (`src/lib/github/binding.ts`, `app-state.ts`): load a proved binding, set or clear `Repository.installationId`, bind with proof, unbind, single-use state claim | Implemented |
| Schema: `GithubInstallation`, `WorkspaceInstallation` (with proof columns), `GithubDelivery`, `GithubAppState`, `Repository.installationId` with a composite foreign key to the binding | Implemented (migration `20261123100000_github_app`) |
| Environment parsing and validation (`src/lib/github/app-config.ts`), wired into the hosted startup check | Implemented |
| App JWT and installation tokens with in-memory cache (`src/lib/github/app-auth.ts`) | Implemented |
| Fake GitHub for tests: app, user, OAuth and membership routes in `src/lib/github/fake-server.ts` | Implemented |
| Connect flow: Settings > GitHub, the start actions, the callback route (`/api/github/app/callback`), proof of control, disconnect, "Check again" | Implemented (not yet run against live GitHub, see "Needs a live check") |
| Loss detection when a token cannot be minted (`installation-health.ts`: `withInstallationHealth`, `noteInstallationError`) | Implemented; wrapping the factory's token provider with it is the next task |
| Webhook route (`/api/github/webhook`): signed deliveries queue refreshes and record installation lifecycle changes; daily pruning; slower reconcile for live installations | Implemented (not yet run against live GitHub, see "Needs a live check") |
| Read-only data access: `portForSync` / `portForDiscovery` use the repository's (workspace's) installation token; `GET /installation/repositories` listing and admin tracking on "Connect repositories"; sync, reconcile and budgets per installation; private repositories visible by grant only | Implemented (this phase) |
| Writes to GitHub (`portForWrite`) | Off: "GitHub writes are not enabled yet". Only two opt-in writes exist, made as the person: see "Writing to GitHub as you" (`MERGEPORT_GITHUB_WRITES`, off by default) |
| Per-person GitHub link and GitHub-verified repository access (`user-link.ts`, `user-token.ts`, `user-access.ts`, `access-cache.ts`; Settings > GitHub account; migration `20261124100000_github_user_link`) | Implemented (not yet run against live GitHub, see "Needs a live check") |
| Sign in with GitHub (`sign-in.ts`, `/api/github/signin/start` and `/callback`, the button on the sign-in page; migration `20261128100000_github_signin`) | Implemented (not yet run against live GitHub, see "Needs a live check") |

A workspace with a proved binding syncs through its installation; one without stays on "GitHub is not connected yet". Setting the variables
below only validates at startup; what a workspace can read still depends on its bindings.

### Reading through an installation

`Repository.installationId` (set only by `src/lib/github/binding.ts`, when an administrator tracks a repository from "Connect repositories") decides
which installation reads a repository. Budgets are `installation:<id>`, the ETag cache is partitioned under `inst:<id>:`, and an uninstalled or
suspended App is recorded by `markInstallationState` and finishes jobs without retry. The token sees everything the installation can access;
who in the workspace sees a private repository is Mergeport's decision (docs/roles.md, `repoWhere`).

## Register the App (operator, once per deployment)

GitHub, Settings (or the organisation's Settings), Developer settings, GitHub Apps, New GitHub App.

- **Homepage URL**: your public URL, `<public url>` below (the value of `MERGEPORT_PUBLIC_URL`).
- **Callback URLs** (GitHub allows several): `<public url>/api/github/app/callback` (connecting a workspace) and `<public url>/api/github/link/callback` (people linking their own GitHub account) and `<public url>/api/github/signin/callback` (people signing in with GitHub). GitHub matches the redirect address exactly, so all of them must be registered as written. **Tick "Request user authorization (OAuth) during installation"**: the install page then returns a `code` that proves who the installer is. Leave "Expire user authorization tokens" on (the default).
- **Webhook**: active, URL `<public url>/api/github/webhook`, and a random secret of at least 16 characters (use 32 or more).
- **Where can this App be installed**: "Any account" if customers install it on their own accounts, otherwise "Only on this account".
- **Account permissions** (user permissions): **Email addresses, Read-only.** "Sign in with GitHub" asks `GET /user/emails` for the person's primary, verified address; without this permission GitHub answers 403 and sign-in of NEW people fails with a "server settings" message (people already linked still sign in). GitHub shows the permission to each person on the authorization page.
- **Organization permissions**: Members, Read-only. The connect flow asks GitHub whether the person is an owner of the organization they connect (see "Needs a live check"); without this permission that check is refused and nobody can connect an organization.
- **Repository permissions**, all Read-only:
  Issues, Pull requests, Checks, Commit statuses, Metadata (always on). Add Contents (read) if branches and commits should refresh from events.
  **Only if you will set `MERGEPORT_GITHUB_WRITES=on`:** raise Issues and Pull requests to Read and write (see "Writing to GitHub as you"); every installation owner then has to accept the new permissions.
- **Subscribe to events**: Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Pull request review thread,
  Check run, Check suite, Status. With Contents: Push, Create, Delete.
  (`installation` and `installation_repositories` are always delivered to an App; `repository`, `label` and `milestone` are optional extras that are handled when subscribed.)
- Generate a **private key** (PEM) and a **client secret**. Note the **App ID**, **Client ID** and the **slug** (the last part of
  `https://github.com/apps/<slug>`).

If a feature later needs more access (merging, other writes), the permission is added to the App and each installation owner has to
accept the change; this document and the manifest list are updated together. The Issues and Pull requests write permissions for the opt-in writes are described in "Writing to GitHub as you".

## Environment

| Variable | Meaning |
| --- | --- |
| `MERGEPORT_GITHUB_APP_ID` | Numeric App ID. |
| `MERGEPORT_GITHUB_APP_PRIVATE_KEY` | The PEM private key. Newlines may be written as `\n` so it fits on one line; surrounding quotes are removed. RSA, at least 2048 bits. |
| `MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE` | Path to a PEM file instead of the variable above. Set exactly one of the two. Preferred where a secrets file mount is available. |
| `MERGEPORT_GITHUB_APP_WEBHOOK_SECRET` | The webhook secret; at least 16 characters. Used exactly as written: leading or trailing whitespace (a stray newline from a secrets file) is a startup problem, not silently trimmed. |
| `MERGEPORT_GITHUB_APP_CLIENT_ID` | The App's client ID. |
| `MERGEPORT_GITHUB_APP_CLIENT_SECRET` | The App's client secret; at least 20 characters. |
| `MERGEPORT_GITHUB_APP_SLUG` | The App's URL name: lowercase letters, digits, hyphens, at most 39 characters. |
| `MERGEPORT_ENCRYPTION_KEY` | Also required for people to link their own GitHub account: it encrypts their GitHub token (same variable and format as in `docs/federation.md`). Without it the link is unavailable and Settings says so. **Rotating it makes every stored token undecryptable: people must link again.** |
| `MERGEPORT_GITHUB_WRITES` | `on` or `off` (default `off`). The deployment ceiling for the two opt-in GitHub writes (create an issue from a task or the new issue page, comment), made with each person's own token. Needs `MERGEPORT_ENCRYPTION_KEY` and a per-workspace switch in Settings, GitHub. Any other value is a startup problem. See "Writing to GitHub as you". |
| `MERGEPORT_GITHUB_API_BASE` | Tests and local development only: replaces `https://api.github.com`. Honoured only when `NODE_ENV` is `test` or `development`, and only for https or http on a loopback name. **A hosted deployment refuses to start with it set**, except a local `next dev` run (`NODE_ENV=development`): see `docs/dev-github-fake.md`. |
| `MERGEPORT_GITHUB_WEB_BASE` | Tests and local development only: replaces `https://github.com` for the authorize, install and OAuth token addresses (the fake GitHub, `docs/dev-github-fake.md`). Honoured only when `NODE_ENV` is `test` or `development`, and only for http(s) on a loopback name. Refused on a hosted deployment exactly like the API base. |

Rules:

- All of the seven required values unset: the App is not configured, and hosted workspaces keep showing "GitHub is not connected for this workspace".
- Some set, some missing or invalid: a startup problem (the hosted configuration check refuses to start, and lists each problem by variable
  name). A half-configured App never limps along.
- Messages name variables and never repeat a value.

## Secrets

- The private key and installation tokens are never stored in the database and never logged. The key lives in the environment (or the file
  you point at); tokens live only in a per-process memory cache.
- The app JWT is RS256, `iat` = now minus 60 s, `exp` = `iat` + 9 minutes (GitHub allows at most 10 minutes), `iss` = App ID.
- The configuration (including the key file) is read once per process and remembered; any change, including a rotated key, needs a restart.
- A token is minted only for a `BoundInstallation`: a workspace's binding with proof (`WorkspaceInstallation.verifiedAt`, `verifiedGithubUserId`,
  `proofMethod`), loaded by `loadBoundInstallation` for an installation that is neither suspended nor deleted. A bare installation id from a webhook or
  a callback cannot reach GitHub; a forged object is refused at run time.
- Installation tokens are cached per installation id, refreshed when less than 10 minutes of their one hour remain, and one request is shared by
  concurrent callers. "Uninstalled" (404) and "suspended" (403) answers are remembered for 60 seconds so a gone installation is not hammered.
  Both caches sweep expired entries on insert and hold at most 5000 entries (oldest evicted first).
- The token request has a 10 second deadline that also covers reading the body (a hung request fails with `unavailable` and the next caller starts a
  fresh one), and a response body over 1 MB is refused.
- Errors are typed (`InstallationGoneError`, `InstallationSuspendedError`, `RateLimitedError`, `AppMisconfiguredError`) with fixed messages;
  GitHub's response text is never copied into them.
- Rotating the private key: generate a new one in the App settings, deploy it, then delete the old one. Running processes pick it up on restart.
- With several server processes each keeps its own token cache; that costs a few extra token requests, nothing more.

## Testing

No test talks to GitHub. `FakeGitHubServer.registerApp()` makes a key pair; `addInstallation()`, `issueUserToken()` and `appFetch()` emulate
`POST /app/installations/:id/access_tokens` (the app JWT is verified: signature, `iat`, `exp`, `iss`), `GET /app/installations/:id`,
`GET /installation/repositories`, `GET /user/installations` and `GET /user/installations/:id/repositories`. This is a simulation of documented
behaviour, not live verification. The fake also serves `GET /user`, `GET /user/memberships/orgs/:org`, `POST login/oauth/access_token` (single use,
redirect_uri and PKCE S256 checks) and `DELETE /applications/:client_id/token`; `tests/github-connect.test.ts` drives the whole flow through the
real route handler and server actions against it.

## Connect flow

One person who is an owner or administrator of the workspace (`manageGithub`, `docs/roles.md`) connects an installation. Nothing about the installation is
trusted until GitHub itself has shown that this person controls it.

1. **Start** (`startGithubConnectAction`, Settings > GitHub). Refused unless the server is hosted, the App is configured and the person may `manageGithub`.
   It writes a `GithubAppState` row (kind `connect`, or `connect-existing[:account]`): state `<workspaceId>.<random>`, bound to the person and the workspace,
   10 minutes, only hashes stored (of the state and of the browser nonce). It sets an HttpOnly, SameSite=Lax, Secure (https) cookie `mp_gh_connect` holding the
   nonce, scoped to path `/api/github/app`, and answers with the GitHub address; the page navigates there.
   - **Connect GitHub**: `https://github.com/apps/<slug>/installations/new?state=<state>`.
   - **Use an existing installation**: `https://github.com/login/oauth/authorize?client_id&redirect_uri&state&code_challenge&code_challenge_method=S256`. The nonce is
     the PKCE verifier. An optional account name picks one installation when the person has several.
   - Rate limit: 15 starts per person per 10 minutes.
2. **Callback** (`GET /api/github/app/callback`). In this order; every failure ends in a redirect to `/settings/github?github=<fixed code>` and nothing else:
   a signed-in session (otherwise sign in, nothing consumed); rate limit (20 per person per 10 minutes); state shape; `claimAppState` (one conditional UPDATE:
   same workspace prefix, hash, unused, unexpired); the claim belongs to the signed-in person; the nonce cookie matches in constant time (the cookie is deleted
   only once the state was claimed, so a forged or malformed GET cannot break a flow in progress; a callback without a well-formed state costs no rate-limit quota); the person is still an ACTIVE member whose role may `manageGithub`. Then: exchange the `code` (client id and secret; the PKCE verifier on the
   authorize path); `GET /user`; `GET /user/installations` (all pages); the installation must be in that list (on the install path the `installation_id` query
   value is only a CLAIM to look for, never used on its own); `GET /app/installations/:id` with the app JWT for the authoritative account, type, selection and
   suspension; **proof of control** (next point); then `bindInstallation` writes the global installation facts, the `WorkspaceInstallation` row (`verifiedAt`,
   `verifiedGithubUserId`, `proofMethod`, `connectedByUserId`) and the audit record in one transaction. The user token is revoked at GitHub (best effort) and dropped.
3. **Proof of control** (`ProofProvider`, default `membershipProofProvider`): a personal account needs `account.id` to equal the GitHub user's id
   (`user-installations:self`); an organization needs `GET /user/memberships/orgs/<org>` to answer 200 with `role: admin` and `state: active`
   (`user-installations:org-admin`). Any 403, 404, other status, odd body, `pending` state or non-admin role is a refusal: "Could not verify that you are an owner
   of the organization. Ask an owner of the organization to connect it, or install the App yourself."
4. **Several workspaces**: one installation may serve several workspaces, but each needs its own fresh proof by someone who passes the check above. The same
   workspace and installation again is idempotent (proof refreshed, one row).
5. **Disconnect** (`disconnectGithubInstallationAction`, behind a confirmation): `unbindInstallation` detaches the workspace's repositories (they stay, as "not
   connected"), deletes the binding and audits. No planning data is deleted. Other workspaces keep their bindings.
6. **Check again** (`checkGithubInstallationAction`): asks GitHub (as the App) about one installation of this workspace and records or clears `suspendedAt` /
   `deletedAt`. Webhooks normally do this by themselves; this is the way back when one was missed.
7. **Loss detection**: `withInstallationHealth(db, provider)` wraps an installation token provider; a 404 (`InstallationGoneError`) sets `deletedAt` and a suspended
   403 sets `suspendedAt`, so Settings shows "Removed on GitHub" or "Suspended on GitHub" and `loadBoundInstallation` stops handing the installation out.

## Webhooks

`POST <public url>/api/github/webhook` (`src/app/api/github/webhook/route.ts`, Node runtime). It exists only on a hosted deployment whose App is fully
configured (anything else: 404). The secret is `MERGEPORT_GITHUB_APP_WEBHOOK_SECRET`, used exactly as written.

**Order of work** (each step before the next; nothing touches installations, repositories or deliveries until the signature holds):

1. A declared `Content-Length` over 1 MiB is refused (413) before reading; the body is then read with a hard 1 MiB cap on the stream itself (413).
2. `X-Hub-Signature-256` must be `sha256=` plus 64 hex digits and equal HMAC-SHA256 of the RAW body (constant-time compare of equal-length buffers; the hex may be
   upper or lower case, the prefix is exact). Missing, malformed, wrong length, wrong secret or truncated body: 401. Only an abuse counter is written.
3. Invalid signatures only are limited per address (30 a minute, 429; `RateLimitState`, address from `X-Forwarded-For` via the trusted proxy chain, stored as a hash). `MERGEPORT_TRUST_PROXY=true` is required on a hosted deployment and the startup check enforces it (`hostedConfigProblems`). A validly signed delivery is NEVER answered 429 (GitHub does not retry): per installation, more than 3000 events a minute are acknowledged with 202 `shed` and not queued (logged; the reconcile covers them).
4. `X-GitHub-Event` (lower-case letters and underscores) and `X-GitHub-Delivery` (letters, digits, hyphens, 8 to 64 characters) are required (400). `ping`: 200, no writes.
5. The body is parsed (400 unless a JSON object). An event or action this deployment does not act on: 202, no writes. A handled event without a usable
   `installation.id`: 400. An installation we do not hold: 200, no writes (a webhook never creates an installation or a binding).
6. The delivery id is inserted (`GithubDelivery`, `ON CONFLICT DO NOTHING`; zero rows means a duplicate: 200 `duplicate`, nothing else happens). Then the jobs are queued OUTSIDE any
   transaction (`enqueue` settles create races by retrying, which an aborted Postgres transaction cannot). If queueing fails, the delivery row is deleted again and the answer is 500, so
   GitHub's "Redeliver" works (jobs already queued are coalesced by their dedupe keys). Only then are the live stamps set (`GithubInstallation.lastWebhookAt`, `Repository.lastEventAt`, each at most once a minute).

The route never calls GitHub: handlers queue jobs or flip a state, so the answer is fast. It reads no cookie and no session; `src/proxy.ts` exempts exactly
`POST /api/github/webhook` on a hosted deployment from the browser Origin rule (the signature is the credential), like the federation token endpoints.

**Ids only find our rows.** `payload.installation.id` must match a `GithubInstallation` we hold; `payload.repository.id` is matched only against `Repository` rows whose
`installationId` is that installation, in each workspace bound to it. A validly signed payload that names another installation's repositories matches nothing.

| Event | Action | Result for each tracked repository (per workspace, own job and workspace id) |
| --- | --- | --- |
| `issues`, `issue_comment` | any | `sync.item` for `issue.number`, dedupe `item:<repository>:<number>` |
| `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | any | `sync.item` for `pull_request.number`, same key |
| `check_run`, `check_suite` | any | `sync.item` per pull request listed (at most 10), else `sync.repository` |
| `status`, `push`, `create`, `delete`, `label`, `milestone` | any | `sync.repository`, dedupe `sync:<repository>` (the key reconcile and Refresh share, so bursts coalesce) |
| `repository` | `publicized`, `privatized`, `renamed`, `transferred`, `edited`, `archived`, `unarchived`, `deleted` | `sync.repository` at once. The visibility flip (grants revoked, digests purged) is `syncRepository`'s job, not duplicated here. A deleted repository answers 404 in the job, which marks it DISCONNECTED exactly as reconcile does; planning data stays. |
| `installation` | any | one `github.installation.check` job per installation (dedupe `ghinst:<id>`, system job). It asks GitHub as the App (`GET /app/installations/:id`) and records what is TRUE now: 404 = deleted, `suspended_at` set = suspended, else active; audit rows (one per bound workspace) only when the recorded state really changes. The action word is never trusted, because deliveries arrive late and out of order. |
| `installation_repositories` | any | the same check job; for `removed` also a `sync.repository` per tracked repository named in `repositories_removed` (at most 2000 ids per delivery, read in chunks; beyond that the reconcile is pulled forward). A repository GitHub really removed from the installation answers 404 in that job and `syncRepository` marks it DISCONNECTED (existing path); one that is still readable stays connected. Nothing is detached directly. |

Bindings and their proof columns are never touched by a webhook. A sync job against a suspended installation does nothing (not connected) and keeps the recorded state; the check job, "Check again" or a later event moves it.

**Redelivery.** GitHub reuses the delivery id when someone redelivers. After a delivery succeeded, redelivering it is a no-op by design (`duplicate`). After a failure
(500) nothing was recorded, so it is processed normally. Ids are kept for 7 days.

**Maintenance and pacing.** A daily system job (`github.maintenance`) deletes `GithubDelivery` rows older than 7 days, `GithubAppState` rows past their expiry and expired `RateLimitState`
counters (not the GitHub budget rows), in batches of 1000. A repository that an event named within 24 hours (`Repository.lastEventAt`) and that synced cleanly within the last hour is skipped by the
15-minute reconcile (so about hourly); never-synced, failed, rate-limited, DISCONNECTED and silent repositories are reconciled every run, so the safety net stays. Settings > GitHub shows
"Live updates": "On (last event ..., reconciles about hourly while events arrive)", "Waiting for the first event from GitHub", or "Updates arrive about every 15 minutes".

## Threat notes

- **Forged or replayed callback**: the state is single use (atomic claim), expires in 10 minutes, belongs to one person and one workspace, and is useless without
  that browser's nonce cookie. A callback URL pasted into another browser or session fails before any GitHub call.
- **Someone else's installation**: the installation id is a claim. It must appear in the list GitHub returns for this person's own token, and control is proved
  separately. Being able to see an installation (as a collaborator, say) is not control.
- **Cross-workspace**: the state names its workspace and the claim checks it; membership and role are re-read for that workspace at callback time. Binding one
  workspace never touches another's rows.
- **CSRF**: the start is a server action (Next's same-origin check and `proxy.ts` refuse a cross-site POST). The callback is a GET that only acts after the state
  claim and the cookie nonce, so a cross-site link cannot complete a flow someone else started.
- **Secrets**: the user token lives inside one callback, is never stored, logged, put in an error or sent to the browser, and is revoked at GitHub. The client
  secret is only sent to GitHub's token endpoint. Redirects carry one fixed result code and nothing from the query or from GitHub. The callback answers with
  `Referrer-Policy: no-referrer`.
- **Open redirect**: no request value is a destination; the only targets are `/settings/github?github=<code>` and `/sign-in?next=/settings/github`.
- **Uncertainty is refusal**: unexpected GitHub answers, timeouts, oversize bodies, a membership answer that is not a clear "active admin", or an unreadable
  suspension time never produce a binding.

## Linking your GitHub account

A signed-in hosted person (any role, a reader included) can link THEIR GitHub account. Mergeport then asks GitHub, with that person's own
token, which repositories they can open, and uses the answer as one of the two ways a MEMBER or READER sees a repository (the exact rule is in
`docs/roles.md`, "Repository visibility"). Mergeport posts nothing on their behalf with it unless the opt-in writes below are on for the workspace, and then only what the person confirms (an issue from a task or the new issue page, a comment). Local
mode is untouched (no route, no panel).

**Flow** (`src/lib/github/user-link.ts`; same pattern as the connect flow, whose helpers it reuses: `claimAppState`, the nonce hash, the PKCE
challenge, `connect-api.ts`):

1. `startGithubLinkAction` (`src/app/github-link-actions.ts`, any signed-in role; hosted only; needs the App and `MERGEPORT_ENCRYPTION_KEY`)
   writes a single-use `GithubAppState` of kind `link` (hash only, the person and the active workspace, 10 minutes), sets an HttpOnly
   SameSite=Lax nonce cookie `mp_gh_link` limited to path `/api/github/link`, and answers with GitHub's `login/oauth/authorize` address
   (`redirect_uri` is `<public url>/api/github/link/callback`, PKCE S256 with the nonce as verifier, no secret, `allow_signup=false`). Ten starts
   per ten minutes per person. Refused while a working link exists.
2. `GET /api/github/link/callback`: session required (without one nothing is consumed), the state is claimed once (shape, expiry, same
   person, kind `link`, nonce cookie in constant time, still an ACTIVE member of the workspace it was made in), the code is exchanged
   (`exchangeCodeForTokens`, with the PKCE verifier), and `GET /user` says which GitHub account the token belongs to (numeric id and login). The
   answer is a redirect to `/settings?githublink=<code>`: one of the fixed codes in `link-messages.ts`, looked up in a table, never a query value.
3. **Refusals** (nothing is written, the token of the attempt is revoked at GitHub, a fixed message is shown): that GitHub id is already
   linked to a DIFFERENT Mergeport person (`github-taken`); this person already has a DIFFERENT GitHub account linked (`other-account`: unlink
   first). Accounts are never matched or merged by email, name or anything in the query. Two people linking the same id at the same moment: the
   unique keys (`User.githubId`, `Identity (provider, subject)`) let exactly one transaction commit; the other gets `github-taken`.
4. On success, in one transaction: `Identity(provider github, subject = numeric id)`, `User.githubId`, `User.githubLogin`, the encrypted token
   (`GithubUserToken`) and an audit row `github.link`; then the first `github.access.refresh` job is queued.

**Token storage** (`user-token.ts`): `GithubUserToken` (GLOBAL like `User`, one row per person). Both the access and the refresh token are
AES-256-GCM ciphertext (`encryptSecret`, key `MERGEPORT_ENCRYPTION_KEY`, AAD `ghusertoken:<userId>`), so a ciphertext copied to another row, or
made under another key, does not open and the link then needs renewing. Without the key linking and the checks are unavailable and say so.
GitHub App user tokens expire (about 8 hours, refresh token about 6 months: **unverified**, see below): the lifetimes are stored as dates
taken from the token response, never assumed, and a token with no expiry in the answer is used until GitHub refuses it. Renewal is on demand and
single flight (one in-process promise per person plus a row lock `FOR UPDATE` held for the exchange so two processes cannot spend one refresh
token twice); GitHub rotates the refresh token and the new pair replaces the old one in the same update. **Only a GitHub-side refusal ends a link:**
a 401, or a 403 whose body says bad credentials, a revoked token or SAML enforcement, is a dead token; rate limiting (403 with `x-ratelimit-remaining: 0`,
`retry-after` or a "rate limit"/"abuse" message, and 429), any other 403, 5xx and network failures throw "unavailable" and change nothing (the job retries
with backoff; cached rows age out but the link and the stored token survive). A ciphertext that does not open (a wrong or changed key, mid-deploy) is not a
refusal either: the feature reports "unavailable", the row is left alone and a counter line (no values) is logged. A relink decision is taken inside the row lock and only when
the row is still the version the run used. A refresh token GitHub refuses (or that has
expired) sets `status = RELINK`, clears both ciphertexts, deletes the person's cached access and stops all checks until they link again (no loop);
GitHub being unreachable changes nothing and is retried. Tokens live only in local variables: never in a log, an error message, a cookie, a URL or a
page. The consequence of a crash after GitHub rotated a refresh token but before the row was written is a relink, which is safe.

**Access cache and refresh job** (`access-cache.ts`, `user-access.ts`): `GithubRepoAccess (userId, repositoryGithubId, installationId, permission, checkedAt)`,
unique on (user, repository), GLOBAL and keyed by user (every read names the user id; nothing reads another person's rows). Job `github.access.refresh`
(payload `{ userId }`, dedupe key `ghaccess:<userId>`, no workspace: it serves a person who may belong to several), whose body takes one user id and uses
only that person's token:
`GET /user` (must be the linked numeric id, else the link needs renewing; also refreshes `User.githubLogin`), `GET /user/installations`, and for each installation
that is bound to a workspace the person is an ACTIVE member of (and neither suspended nor deleted) `GET /user/installations/{id}/repositories`
(100 per page, at most 50 pages). Rows of an installation are replaced in one transaction only when it was listed completely; a failed or cut-off listing leaves its
rows to age out, reports `partial` and keeps `accessCheckedAt` old so the next trigger tries again. The write transaction re-checks that the link is still the same
(token row locked, status OK, same GitHub id), so an unlink that lands mid-refresh wins. When a refresh removes rows, the person's stored digests are purged.
Triggers: right after linking; a page load that finds `accessCheckedAt` older than 10 minutes (`REFRESH_AFTER_MS`; queued, never awaited, at most once a minute per person);
`reconcile.all` for every linked active person whose data is old (oldest first, 200 per run); "Check again" on Settings. Budget: `RateLimitState` key `user:<id>`, 12 refreshes per
10 minutes per person; past it the job returns without calling GitHub.

**Truncation.** A listing that hits the page cap (50 pages of 100 per installation), or a person with more than 5000 repositories, marks the check `accessTruncated` with
`accessRepoCount`; Settings then says "Showing access for the first 5,000 repositories", and a counter line is logged. The viewer's list is ordered by `checkedAt` descending then GitHub id
and capped at 5000. The freshness cutoff is passed to SQL as an ISO string cast to `timestamp(3)` (like `jobs.ts`), so a database session time zone cannot shift it.

**Unlink** (`unlinkGithubAction`, the person themself, behind a confirmation): revokes the token at GitHub (best effort, `DELETE /applications/{client_id}/token`), then in one
transaction deletes the token, the github `Identity` and every `GithubRepoAccess` row of the person, clears `githubId` and `githubLogin`, purges their stored digests in every workspace
and writes an audit row; repeating it does nothing more. Removing a member (or a member leaving) deletes the cached access that came through that workspace's installations
(kept where another workspace they still belong to uses the same installation) and their digests.

**Revocation lag.** Mergeport asks GitHub; nothing pushes a change to it yet (webhooks arrive in another task). After access is removed on GitHub the person keeps seeing the
repository until the next refresh of their data lands and, at the latest, until their last good check is `VALID_FOR_MS` (30 minutes) old. Stale rows grant nothing.

**Security notes.** State, nonce and PKCE are single use, expire in 10 minutes and are bound to the person; the callback without a session consumes nothing; the callback target
is always a path on this site; the start, unlink and check actions are server actions behind Next's same-origin check and `proxy.ts`'s Origin rules (a cross-site POST gets 403); the
three actions act on the caller's own link only and are listed with reasons in `tests/mutation-guard.test.ts`; the job isolation, the per-user budgets and all the refusals above are
covered by `tests/github-link.test.ts` and `tests/github-access.test.ts`; the UI by `tests/github-link-ui.test.tsx`. The webhook route and its proxy exemptions are not touched.

## Signing in with GitHub

Hosted only, and only when the App above is fully configured and `MERGEPORT_ENCRYPTION_KEY` is set (the user token is kept, exactly as when linking). The sign-in page then shows
"Continue with GitHub" above the other providers; with no App, a partly set App, no key or a local run there is no button and both routes answer 404. No new variable: it is the same App, client id and secret.

**Flow** (`src/lib/github/sign-in.ts`; it reuses the link flow's helpers: nonce hash, PKCE, `exchangeCodeForTokens`, `getUser`, `revokeUserToken`, `storeUserTokens`, `oauthAuthorizeUrl`):

1. `GET /api/github/signin/start[?next=/path]` (a plain link, like the OpenID Connect start): per client address 20 starts per 10 minutes (`auth:ghsi:start:<hash>`; the address is the trusted-proxy entry from `docs/auth.md`; without one the route answers 503), a single-use
   `GithubSigninState` row (state hash, nonce hash, the safe `next`, 10 minutes; GLOBAL, no workspace, nothing else), an HttpOnly SameSite=Lax nonce cookie `mp_gh_signin` limited to path `/api/github/signin`, and a redirect to `login/oauth/authorize`
   (`redirect_uri` is `<public url>/api/github/signin/callback`, PKCE S256 with the nonce as verifier, `allow_signup=false`).
2. `GET /api/github/signin/callback`: a callback without a well-formed state costs nothing and consumes nothing; then 20 callbacks per 10 minutes per client address; then the state is claimed with ONE conditional UPDATE (single use, unexpired), the nonce cookie is compared in
   constant time (only a claimed state spends the cookie), the code is exchanged with the PKCE verifier, and `GET /user` names the account (numeric id). The answer is a redirect with `Referrer-Policy: no-referrer` and one fixed code
   (`/sign-in?error=github-<code>`), or, on success, a NEW session (the old cookie's session is destroyed first, as for every sign-in) and the same landing rule as the other methods (`/onboarding` for someone in no workspace, an invitation link kept).
   A session the browser arrived with is never consulted.

**Who the person is: the numeric GitHub id, never the login** (a login can be released and reused). In order:

1. The id is already linked (`Identity github`, or `User.githubId` for a legacy person): that person signs in. The address is not looked at and `GET /user/emails` is not called. The token is stored again (a sign-in is a fresh authorization, so a link that needed renewing is renewed), `githubLogin` is refreshed, audit `github.signin` in each workspace the person is ACTIVE in.
2. Unknown id, GitHub's PRIMARY address and GitHub says it is VERIFIED (`GET /user/emails`, both flags required; no other address, no unverified one, not the profile email, never the login), and NO account here holds that address: a new person is created with that address as
   a verified email (the same state a magic link leaves), `githubId`, `githubLogin`, an `email` and a `github` identity and the encrypted token. They continue like any new person: `/onboarding`, where invitations to that address are already waiting (`pendingInvitationsFor`) and can be joined.
3. Unknown id whose verified address an account here already holds (as `User.email`, whether or not that holder ever verified it, or as an `email` identity): **refused. Nothing is linked, nobody is signed in, the token is revoked at GitHub** and the person is told to sign in with an email link to that address first and link GitHub from Settings.
   Auto-linking would let anyone who controls a GitHub account with that address (an old address that was released, a GitHub account created with an address the owner never confirmed on this side) take the existing account. Audit `github.signin_refused` (reason and GitHub id, no address) in each workspace of the holder; a holder in no workspace leaves only a log line without values.
4. No verified primary address (none, unverified, only a non-primary one, unusable text): refused with a message; the App lacking the email permission (403 or 404 from `GET /user/emails`) is reported as a server setting problem, not as the person's.

Removed or suspended members are not special: like every other method, signing in gives a session, and a person with no ACTIVE membership lands on `/onboarding` with no access to the workspace; membership is re-checked on every request. Two first sign-ins of one account at the same moment make one person (unique keys on `githubId`, the identity and the address; the loser retries and finds the winner).

**Not changed:** linking from Settings (`/api/github/link/callback`), the connect flow, the webhook, `proxy.ts` (the callback is an ordinary browser GET; the Origin rule for state-changing methods applies unchanged to every route).
Tests: `tests/github-signin.test.ts` against the fake GitHub (`FakeGitHubServer.setEmails`, `forbidEmails`).

## Writing to GitHub as you

Off by default, narrow on purpose, and made as the person. The scope is exactly these writes: **create an issue from a Mergeport task** (the "Also create a GitHub issue" option in New task and "Turn into a GitHub issue" on a task) and **post a comment on a tracked issue or pull request**, plus **edit an issue's or pull request's description, or a conversation comment** (Edit on the item page: offered on the description to anyone who may write there, on a comment only to its GitHub author or someone whose cached GitHub permission is admin or maintain; the text is sent exactly as typed, line endings normalised, no footer added; the same text again is a no-op; GitHub decides and its refusal is explained; audited as `github.write.issue.edit` and `github.write.comment.edit`). Mergeport never merges, closes, deletes, pushes, edits review or inline comments, changes labels, assignees or milestones on GitHub, requests reviewers or submits a review, and GitHub writes are not offered over MCP (docs/mcp.md).

**Three switches, all must be on.**

1. The deployment ceiling: `MERGEPORT_GITHUB_WRITES=on` (default `off`; anything else is a startup problem on a hosted deployment, and `on` also needs `MERGEPORT_ENCRYPTION_KEY`). With it off nothing in the app writes to GitHub and no option is shown.
2. The workspace switch: Settings, GitHub, "Write to GitHub as you" (owners and administrators, `manageGithub`). Default off. Shown only while the ceiling is on. Turning it on or off is audited (`github.writes.enable`, `github.writes.disable`); it is `Workspace.githubWritesEnabled`.
3. The person: they must have linked their own GitHub account (Settings, Linked accounts) with a working link (not "needs a new sign-in"), and GitHub's own answer for them must be cached: a fresh `GithubRepoAccess` row for the repository with `pull` or better is the "may see this repository" gate. What they may DO there is GitHub's answer: Mergeport calls and maps the refusal.

**As the person, never as the installation.** The call uses the person's own user-to-server token (decrypted for the call, renewed through `user-token.ts`, never logged or shown). GitHub therefore authorizes and attributes the issue or comment to them. The installation token is never used to write (a test asserts it), and the repository must belong to an installation this workspace proved it controls. A token GitHub refuses is renewed once, the call retried once (a 401 means nothing was written), and then the link is marked "needs a new sign-in".

**Mergeport's own checks, before GitHub is asked** (`src/lib/github/writes.ts`):

- The Mergeport capability: `requireRepo(..., "manageWork")`, so a READER, or a member whose only access is GitHub-verified visibility (no grant), is refused, exactly as for any other change.
- Plain text only (no control or bidirectional-override characters), title at most 256 characters on one line, text at most 20,000. Labels of a task are not sent.
- A new issue or comment ends with a footer line, `Created from Mergeport` (an edit adds none: the text is sent as typed), and nothing else of ours (no tokens, no internal ids). The confirmation sheet shows the repository, the title and the text exactly as it will be sent (`ConfirmSheet`); nothing is sent before it is confirmed. Ticking the New task option only creates the task and opens that preview.
- Budgets in the rate-limit table: 20 writes per person per hour (`ghwrite:user:<id>`), 100 per workspace per hour (`ghwrite:ws:<id>`).
- Idempotency: a task that already follows an issue (or whose created issue is waiting to be matched by the next sync) cannot create a second one, and a one-shot lock per task (`ghwrite:issue:<task>`) makes a double submit create one issue. An identical comment sent twice within two minutes is refused as a duplicate. The lock is released when GitHub refuses.
- Audit rows: `github.write.issue.create`, `github.write.comment`, `github.write.issue.edit` and `github.write.comment.edit` (repository full name, issue number, the person; never a token) and `github.write.<kind>.failed` (repository, reason, GitHub's status).
- After a success the task keeps its link (work item, or repository plus number until the mirror has it: `linkPendingTasks` in the `sync.item` job finishes it) and a `sync.item` job is queued so the mirror updates.

**What the person sees when it is refused** (all fixed texts, `REFUSAL_MESSAGES` and `explain` in `writes.ts`): turned off by the server (the option is simply absent), turned off for this workspace, "Link GitHub first", "needs a new sign-in", access not confirmed yet, a rate limit, and for GitHub's own answers: 403 (their GitHub account may not write there, the conversation is locked, **or the App does not hold the write permission yet**), 404 (no access, renamed or deleted), 410 (issues disabled, or the item was deleted or moved), 422 (GitHub rejected the text), rate limit, SSO, network.

**GitHub App permissions for this feature.** Repository permissions **Issues: Read and write** and **Pull requests: Read and write** (a pull request comment is an issue comment; GitHub's authorization needs both listed). The App stays read-only for everything else. Changing the permissions of an existing App does not apply to existing installations by itself: **an owner of each installation has to accept the new permissions** (GitHub emails them and shows a banner on the installation page), and until they do, GitHub answers 403 to the write and Mergeport says so. Leave the permissions read-only if you never set `MERGEPORT_GITHUB_WRITES=on`.

Tests: `tests/github-writes.test.ts` against the fake GitHub (`FakeGitHubServer.userWrites`, `appLacksWritePermission`, and `failNext` for 403, 404, 410 and 422). Not run against live GitHub: see "Needs a live check", items 28 to 33.

## Known limitations

- A binding is proved once, at connect time. It is not re-proven if the connecting person later loses access (leaves the organization, is demoted). Follow-up: webhook-driven
  re-proof, or re-proving on "Check again".
- Two people connecting the same new installation at once is handled by retrying the transaction once on a unique-key collision (`bindInstallation`); both end connected.

## Needs a live check

Step-by-step instructions for running these checks against real GitHub are in `docs/live-github-runbook.md`.

Everything above is tested against the fake only. Before relying on it, run the flow once against GitHub itself with a real App and write down the answers:

1. `GET /user/memberships/orgs/<org>` with a GitHub App user-to-server token: does it answer 200 with `role: admin`, `state: active` for an organization owner, and
   what does it answer for a plain member and for someone with a pending invitation? Does it need the App's "Members" organization permission (the registration
   steps assume it)? If it answers 403 or 404 for owners, organizations cannot be connected until another `ProofProvider` is used (for example
   `GET /orgs/<org>/memberships/<login>` with the user token).
2. Whether `GET /user/installations` lists suspended installations (the flow refuses those either way; the fake can do both).
3. Whether PKCE (`code_challenge` S256, `code_verifier` at the token endpoint) is accepted on a GitHub App's authorize URL, and that the install page's
   authorization step (no PKCE) still returns `code` and the same `state` together with `installation_id`.
4. The redirect when an organization member who is not an owner asks to install: `setup_action=request` without `installation_id` or `code` (assumed).
5. That `DELETE /applications/<client_id>/token` ends a user token created by this flow (the revoke step is best effort and silent on failure).
6. That `state` comes back unchanged through the install page (including the `.` in it).
7. That the nonce cookie (`mp_gh_connect`, SameSite=Lax, path `/api/github/app`) survives the redirect from github.com back to the callback in Safari and Firefox, not only Chrome.
8. That the callback response really carries the nonce-cookie deletion: the route calls `cookies().delete` and then returns a manually built redirect `Response`; confirm Next merges that
   `Set-Cookie` into it (if not, the cookie lives until its 10 minute expiry, which is harmless because the state is single use, but should be known).
9. That a collaborator who can see someone else's personal-account installation in `/user/installations` is refused (the check is `account.id` equals the user's id; the fake only simulates this).
10. That a pending organization membership (`state: pending`) on `GET /user/memberships/orgs/<org>` is refused (the code refuses anything but `active` plus `admin`; the answer shape is assumed).

### Webhooks

11. That GitHub sends a `ping` to the webhook URL when the App is registered or its webhook is saved, and that the secret check passes for it (200 `pong`).
12. The delivery headers as they really arrive: `X-GitHub-Event`, `X-GitHub-Delivery` (a UUID), `X-Hub-Signature-256` in lower-case hex (header names are case-insensitive; the code reads them through `Headers`).
13. That `installation_repositories` really carries `installation.id` and a `repositories_removed` array of objects with a numeric `id`, and that `installation` events carry `installation.id`.
14. That redelivering an already handled delivery id from "Recent deliveries" answers 200 `duplicate` without queueing anything, and that redelivering one that failed with 500 is processed.
15. That `check_run` / `check_suite` payloads list `pull_requests` (empty for runs on branches of forks or without a pull request, in which case the repository is refreshed instead).
16. That a deletion of a repository (`repository` `deleted`) leads to a DISCONNECTED repository through the 404 in the job, and that `archived` only flags it.
17. That the reverse proxy forwards the body unchanged (no re-encoding, compression or size rewrite) and keeps `X-Hub-Signature-256`, and that 1 MiB is enough for every subscribed event.
18. That `GET /repos/<owner>/<repo>` with an installation token answers 404 (or 403) for a repository that was removed from the installation but still exists, which is what turns a removed repository DISCONNECTED; and that `GET /app/installations/<id>` answers 404 after an uninstall and carries `suspended_at` while suspended.

### Linking your GitHub account (user token and access cache)

19. **User token lifetimes and refresh.** Does the App's token response carry `expires_in` (about 28800) and `refresh_token_expires_in` (about 15811200)? Does a refresh with
    `grant_type=refresh_token` return a NEW refresh token and make the old one stop working, and what does it answer for a revoked or expired one (the code relinks only on `error: bad_refresh_token`
    and treats any other refusal as a temporary problem)? Does the old access token keep working after a refresh (the fake revokes it)? Is "expire user authorization tokens" switched on for the App (if it is off the
    token has no expiry and no refresh token, which the code accepts)?
20. **`GET /user/installations/{id}/repositories` for a GitHub App user token.** Does it list public repositories of the installation for a person who is not a collaborator, and with which `permissions`
    (the code needs a true `pull` and treats a repository without a `permissions` object as no access)? Does it list private repositories only for people with access, and does an organization that restricts
    third-party access (or an App not yet approved by the organization) answer 403 or 404 or an empty list? Is the answer consistent for an organization owner? Is the 100 per page cap and the `link` pagination behaviour as assumed?
21. **PKCE on the App's authorize URL** used by this flow (`/login/oauth/authorize` with `code_challenge`, S256) and `code_verifier` at the token endpoint, with `/api/github/link/callback` registered as one of the App's
    callback URLs (the registration steps must list it next to `/api/github/app/callback`).
22. That the nonce cookie `mp_gh_link` (SameSite=Lax, path `/api/github/link`) survives the redirect back from github.com in Safari and Firefox, and that the callback's cookie deletion is merged into the redirect (as for item 8).
23. That `DELETE /applications/{client_id}/token` ends the stored user token on unlink, and that revoking it does not also remove the person's installation access to anything else.

### Signing in with GitHub

24. **`GET /user/emails` with an App user-to-server token.** Does it answer for a GitHub App token when the App has the "Email addresses: Read-only" user permission, and 403/404 without it? Does the answer carry `primary` and `verified` as assumed, is the list complete without paging for ordinary accounts, and does an account that keeps its address private still list it here? (The code takes only the entry with BOTH `primary: true` and `verified: true`.) Does adding the permission to an existing App make GitHub ask each person to accept it, and what do already-authorized people see?
25. **Callback registration.** That `<public url>/api/github/signin/callback` is accepted as one of the App's callback URLs next to the other two, that GitHub rejects a `redirect_uri` that differs from every registered one (no prefix matching), and that PKCE S256 and `allow_signup=false` are honoured on this authorize request as on the link flow.
26. That the nonce cookie `mp_gh_signin` (SameSite=Lax, path `/api/github/signin`) survives the redirect back from github.com in Safari and Firefox, and that the callback's cookie deletion and the new session cookie are both merged into the redirect (as for item 8).
27. That a person who has never authorized the App (no installation anywhere) can still complete the user authorization flow and gets a user token that can call `GET /user` and `GET /user/emails`, and that a GitHub account with two-factor or SSO enforcement behaves the same.

### Writing to GitHub as you

28. **Permissions.** With the App's Issues and Pull requests permissions set to Read and write, does `POST /repos/{owner}/{repo}/issues` with a user-to-server token create the issue as the person (the issue's author is them, not the App), and does `POST /repos/{owner}/{repo}/issues/{number}/comments` do the same for an issue and for a pull request? Does a user token need any user-level permission besides the repository ones?
29. **Existing installations.** After the permissions are raised, what do installation owners see, and what exactly does GitHub answer (403 with which message) to a write before they accept? Is the answer the same for a person who is the owner of the installation themselves?
30. **Who may do what.** Does GitHub allow a person with only read access to create an issue or comment in a private repository, and in a public one? Mergeport only requires a cached grant with `pull` or better and passes GitHub's answer on, so the real rule decides what people can do. Confirm the 403, 404, 410 (issues disabled) and 422 (empty title, text too long) answers and their bodies for both calls, and a locked conversation.
31. **Organizations with SAML SSO or an App access policy.** Does a user token that was not authorized for the organization's SSO get a 403 with `X-GitHub-SSO` on the write, as the mapped "sso" message assumes?
32. **Attribution.** That the footer line `---` plus `Created from Mergeport` renders as a rule and a plain line on GitHub, and that the issue shows no "via Mergeport" label that would make the footer redundant.
33. **Rate limits.** That user-to-server writes count against the person's own quota and GitHub's secondary rate limit for content creation (a 403 or 429 with `retry-after`) is mapped to the rate-limit message and does not consume the Mergeport budget twice.
