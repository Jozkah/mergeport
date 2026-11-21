# GitHub App (hosted)

A hosted Mergeport deployment talks to GitHub through ONE GitHub App, registered by the operator. Workspaces connect by installing the
App on their GitHub account or organisation; Mergeport then acts through short-lived installation tokens instead of any server-side
`gh` login. See `docs/tenancy.md` for how installations map to workspaces.

## What exists now, and what comes later

| Part | Status |
| --- | --- |
| Schema: `GithubInstallation`, `WorkspaceInstallation`, `GithubDelivery`, `GithubAppState`, `Repository.installationId` | Implemented (migration `20261123100000_github_app`) |
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
| `MERGEPORT_GITHUB_APP_WEBHOOK_SECRET` | The webhook secret; at least 16 characters. |
| `MERGEPORT_GITHUB_APP_CLIENT_ID` | The App's client ID. |
| `MERGEPORT_GITHUB_APP_CLIENT_SECRET` | The App's client secret; at least 20 characters. |
| `MERGEPORT_GITHUB_APP_SLUG` | The App's URL name: lowercase letters, digits, hyphens, at most 39 characters. |
| `MERGEPORT_GITHUB_API_BASE` | Tests and local development only: replaces `https://api.github.com`. **Ignored when `NODE_ENV=production`.** |

Rules:

- All of the seven required values unset: the App is not configured, and hosted workspaces keep showing "GitHub is not connected for this workspace".
- Some set, some missing or invalid: a startup problem (the hosted configuration check refuses to start, and lists each problem by variable
  name). A half-configured App never limps along.
- Messages name variables and never repeat a value.

## Secrets

- The private key and installation tokens are never stored in the database and never logged. The key lives in the environment (or the file
  you point at); tokens live only in a per-process memory cache.
- The app JWT is RS256, `iat` = now minus 60 s, `exp` = `iat` + 9 minutes (GitHub allows at most 10 minutes), `iss` = App ID.
- Installation tokens are cached per installation id, refreshed when less than 10 minutes of their one hour remain, and one request is shared by
  concurrent callers. "Uninstalled" (404) and "suspended" (403) answers are remembered for 60 seconds so a gone installation is not hammered.
- Errors are typed (`InstallationGoneError`, `InstallationSuspendedError`, `RateLimitedError`, `AppMisconfiguredError`) with fixed messages;
  GitHub's response text is never copied into them.
- Rotating the private key: generate a new one in the App settings, deploy it, then delete the old one. Running processes pick it up on restart.
- With several server processes each keeps its own token cache; that costs a few extra token requests, nothing more.

## Testing

No test talks to GitHub. `FakeGitHubServer.registerApp()` makes a key pair; `addInstallation()`, `issueUserToken()` and `appFetch()` emulate
`POST /app/installations/:id/access_tokens` (the app JWT is verified: signature, `iat`, `exp`, `iss`), `GET /app/installations/:id`,
`GET /installation/repositories`, `GET /user/installations` and `GET /user/installations/:id/repositories`. This is a simulation of documented
behaviour, not live verification; the first live check belongs to the connect-flow task.
