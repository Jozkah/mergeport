# GitHub App (hosted)

A hosted Mergeport deployment talks to GitHub through ONE GitHub App, registered by the operator. Workspaces connect by installing the
App on their GitHub account or organisation; Mergeport then acts through short-lived installation tokens instead of any server-side
`gh` login. See `docs/tenancy.md` for how installations map to workspaces.

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
| Webhook route (`/api/github/webhook`) | Later task |
| Rewiring the GitHub port, factory and handlers to installation tokens | Later task |
| User OAuth for signing in, identity linking, visibility rules | Later task |

Connecting a workspace changes only the binding. Repositories keep working as before until the factory is rewired.

## Register the App (operator, once per deployment)

GitHub, Settings (or the organisation's Settings), Developer settings, GitHub Apps, New GitHub App.

- **Homepage URL**: your public URL, `<public url>` below (the value of `MERGEPORT_PUBLIC_URL`).
- **Callback URL**: `<public url>/api/github/app/callback`. **Tick "Request user authorization (OAuth) during installation"**: the install page then returns a `code` that proves who the installer is. Leave "Expire user authorization tokens" on (the default).
- **Webhook**: active, URL `<public url>/api/github/webhook`, and a random secret of at least 16 characters (use 32 or more).
- **Where can this App be installed**: "Any account" if customers install it on their own accounts, otherwise "Only on this account".
- **Organization permissions**: Members, Read-only. The connect flow asks GitHub whether the person is an owner of the organization they connect (see "Needs a live check"); without this permission that check is refused and nobody can connect an organization.
- **Repository permissions**, all Read-only (the same list the hub App manifest uses, `src/lib/hub/github-app-manifest.ts`):
  Issues, Pull requests, Checks, Commit statuses, Metadata (always on). Add Contents (read) if branches and commits should refresh from events.
- **Subscribe to events**: Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Pull request review thread,
  Check run, Check suite, Status. With Contents: Push, Create, Delete.
- Generate a **private key** (PEM) and a **client secret**. Note the **App ID**, **Client ID** and the **slug** (the last part of
  `https://github.com/apps/<slug>`).

If a feature later needs more access (writing comments, merging), the permission is added to the App and each installation owner has to
accept the change; this document and the manifest list are updated together.

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
| `MERGEPORT_GITHUB_API_BASE` | Tests and local development only: replaces `https://api.github.com`. Honoured only when `NODE_ENV` is `test` or `development`, and only for https or http on a loopback name. **A hosted deployment refuses to start with it set.** |

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
   either way); the person is still an ACTIVE member whose role may `manageGithub`. Then: exchange the `code` (client id and secret; the PKCE verifier on the
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
   `deletedAt`. Needed until webhooks exist.
7. **Loss detection**: `withInstallationHealth(db, provider)` wraps an installation token provider; a 404 (`InstallationGoneError`) sets `deletedAt` and a suspended
   403 sets `suspendedAt`, so Settings shows "Removed on GitHub" or "Suspended on GitHub" and `loadBoundInstallation` stops handing the installation out.

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

## Needs a live check

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
