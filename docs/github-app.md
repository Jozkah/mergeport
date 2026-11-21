# GitHub App (hosted)

A hosted Mergeport deployment talks to GitHub through ONE GitHub App, registered by the operator. Workspaces connect by installing the
App on their GitHub account or organisation; Mergeport then acts through short-lived installation tokens instead of any server-side
`gh` login. See `docs/tenancy.md` for how installations map to workspaces.

## What exists now, and what comes later

| Part | Status |
| --- | --- |
| Binding and state helpers (`src/lib/github/binding.ts`, `app-state.ts`): load a proved binding, set or clear `Repository.installationId`, unbind, single-use state claim | Implemented (not called by any route yet) |
| Schema: `GithubInstallation`, `WorkspaceInstallation` (with proof columns), `GithubDelivery`, `GithubAppState`, `Repository.installationId` with a composite foreign key to the binding | Implemented (migration `20261123100000_github_app`) |
| Environment parsing and validation (`src/lib/github/app-config.ts`), wired into the hosted startup check | Implemented |
| App JWT and installation tokens with in-memory cache (`src/lib/github/app-auth.ts`) | Implemented |
| Fake GitHub for tests: app routes in `src/lib/github/fake-server.ts` | Implemented |
| Install / connect flow and the callback route | Later task |
| Webhook route (`/api/github/webhook`) | Later task |
| Rewiring the GitHub port, factory and handlers to installation tokens | Later task |
| User OAuth, identity linking, visibility rules | Later task |

Nothing in the running app calls the new code yet, so setting the variables below changes nothing visible today except startup
validation.

## Register the App (operator, once per deployment)

GitHub, Settings (or the organisation's Settings), Developer settings, GitHub Apps, New GitHub App.

- **Homepage URL**: your public URL, `<public url>` below (the value of `MERGEPORT_PUBLIC_URL`).
- **Callback URL**: `<public url>/api/github/app/callback`. Tick "Request user authorization (OAuth) during installation" when the connect flow ships.
- **Webhook**: active, URL `<public url>/api/github/webhook`, and a random secret of at least 16 characters (use 32 or more).
- **Where can this App be installed**: "Any account" if customers install it on their own accounts, otherwise "Only on this account".
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
behaviour, not live verification; the first live check belongs to the connect-flow task.
