# GitHub access through the GitHub CLI

Mergeport has no GitHub App, no OAuth client and no server holding secrets. Each person signs in to GitHub with the official [GitHub CLI](https://cli.github.com/), and Mergeport asks `gh` to make every request as that person.

## Set up

```bash
winget install GitHub.cli          # Windows. macOS: brew install gh. Linux: see cli.github.com
gh auth login --hostname github.com --web --git-protocol https --scopes repo,read:org
gh auth status
npm run local
```

`npm run local` prints the same login command if you are not signed in. For GitHub Enterprise Server set `MERGEPORT_HOST` (for example `ghe.example.com`) and use the same `gh auth login --hostname`.

## What Mergeport does with the credential

- It never stores your token and never writes it to a log, a file, a shared repository or a response to the browser. It **does** read it transiently: for each profile it runs `gh auth token --hostname <host> --user <login>` once, verifies with that token that it belongs to the profile's numeric user id (`GET /user`), keeps it in memory, and gives it to every `gh api` call through the child process's environment (`GH_TOKEN`, or `GH_ENTERPRISE_TOKEN` for another host), never as an argument. Tokens inherited from the environment (`GH_TOKEN`, `GITHUB_TOKEN`, enterprise forms) are removed from every child. `gh` itself keeps the token in your operating system's credential store where one is available.
- **Every call is bound to the profile's account.** Because the token is chosen by account and verified by numeric id, `gh auth switch` (before, during or after a call) cannot change who a call runs as: the one in flight, the next one, a queued retry, repository creation, an invitation, a sync, a conflict resolution. If the account is not signed in to the CLI, its id no longer matches (a renamed or recycled login), or the CLI is too old to name an account (`gh` 2.40 or newer is needed), the call is blocked with a reason you can act on (`gh auth login --hostname <host>`, then reconnect). A 401 from GitHub drops the remembered token so the next call verifies from scratch.
- Each `(host, user id)` has its own database, caches and unsent edits. If another account is selected in the CLI, Mergeport shows a note, keeps acting only as the profile's own account, and sends nothing as the other one.
- Public repositories can be read without `gh` through the public REST API with caching, pagination and rate-limit handling. Nothing is scraped.

## Windows

- `gh.exe` is found on `PATH`, then in the usual install folders (`Program Files\GitHub CLI`, `Program Files (x86)\GitHub CLI`, `%LOCALAPPDATA%\Programs\GitHub CLI`), so a copy installed after Mergeport started is still found. `MERGEPORT_GH_CMD` overrides it (a JSON array, for example `["C:\\Tools\\gh.exe"]`).
- Arguments are passed to the process as an array with no shell, so paths and values containing spaces, quotes, `&`, `|`, `%`, `$` and Unicode arrive unchanged. `.cmd` and `.bat` shims need a shell and are refused with a message rather than run unsafely; point `MERGEPORT_GH_CMD` at `gh.exe`.
- Timeouts and cancellation kill the whole process tree (`taskkill /T /F`), so a credential helper started by `gh` does not outlive it. Ctrl+C in the console that runs `npm run local` stops the server and every `gh` process it started (exercised on Windows: while idle, and while a `gh` call was hung; see the verification record). In `cmd.exe` Windows may then ask "Terminate batch job (Y/N)?" from npm's own wrapper; the app has already ended. **Forced termination** (Task Manager "End task", `taskkill /F`, a crash, power loss) cannot run any cleanup code, so nothing can be guaranteed after it: a `gh` call in flight may be left to finish or time out on its own, and a refresh that was running stays marked "retrying" until the next start marks it interrupted. SQLite remains consistent and unsent edits are kept (tested after a forced kill).

## Scopes, honestly

`repo` is a **broad** classic scope: it lets the token read **and write** every repository your account can reach, including private ones. It is not a read-only permission, and Mergeport cannot make it one. Mergeport only reads source repositories unless you press an action (comment, review, merge, label…), and it only writes to the private coordination repositories of teams you created or joined. `read:org` lets it list organization repositories you can already see.

Narrower options, with the trade-offs:

- **Fine-grained personal access token** limited to the repositories you want to track (read access to metadata, issues and pull requests; write only if you want to act from Mergeport) plus the coordination repositories (contents read and write). Sign in with `gh auth login --with-token`. Creating a team repository needs a permission to create repositories; if your token lacks it, create the empty private repository on GitHub yourself and join it from the app instead.
- **Organizations with SAML single sign-on** must authorize the token for the organization. Discovery then shows an "additional authorization needed" note with a link rather than silently hiding those repositories.

## What discovery shows

The repository list contains only what **your** connection can enumerate. A repository you cannot list is not guessed, scraped or shown; if an organization requires approval or SSO authorization you see a note saying so.

## Team repositories need source access too

A teammate seeing a shared repository in a board does not mean they can read its issues. Each person's Mergeport fetches GitHub data with their own access. Where they lack it the app says "Source repository access required" instead of showing empty or stale-looking data.
