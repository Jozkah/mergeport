# Developing against a fake GitHub

`npm run dev:github-fake` starts a local stand-in for GitHub (the same in-process fake the tests use, `src/lib/github/fake-server.ts`, behind a plain
HTTP server on `127.0.0.1:4010`). With it you can click through the whole GitHub UI on your machine: connect a workspace, link your GitHub account,
sign in with GitHub, enable writes and create an issue, with no real GitHub App. It is a simulation of documented behaviour, **not** GitHub: it
proves the app's own flow works, never that live GitHub accepts it (that is `docs/live-github-runbook.md`).

What the fake serves:

- A seeded world: organisation `fake-org` (owner `devuser`, member `teammate`), a **public** repository `public-repo` and a **private** one
  `private-repo` (both with a README, issues and pull requests), and the App installed on the organisation.
- The REST surface the app calls: app JWT checks, installation tokens, `/user`, `/user/emails`, `/user/installations`, `/user/memberships/orgs/:org`,
  installation and user repository lists, issues, pull requests, reviews, comments, issue create and comment, issue and comment edits (author or write access), and the OAuth token exchange.
- Browser pages that approve on the spot and send you back: `/login/oauth/authorize` (link and sign-in with GitHub, and "I already have the App
  installed") and `/apps/<slug>/installations/new` (connect). Each answers with a redirect carrying `code` and `state`.
- `http://127.0.0.1:4010/__fake/state`: the installation id, the writes made so far and the last requests, for debugging.

The app talks to it through two variables, honoured **only** when `NODE_ENV` is `development` (or `test`) and **only** for loopback addresses:
`MERGEPORT_GITHUB_API_BASE` (replaces `https://api.github.com`) and `MERGEPORT_GITHUB_WEB_BASE` (replaces `https://github.com` for the authorize,
install and token pages). Production ignores both, and a hosted deployment **refuses to start** with either set unless `NODE_ENV=development`
(`next dev`), which is what lets you run hosted mode locally (below). Do not set them anywhere else.

## Steps

Run each long-lived command in its own terminal, from the repository root.

1. **Install and database.** `npm ci`, then `npm run db:dev` (Postgres on 5433, leave it running). In another terminal: `npx prisma migrate deploy`.

2. **Throwaway App values.** Generate a private key and an encryption key (the key never leaves your machine and is not a real GitHub App key):

   ```
   node -e "const {generateKeyPairSync}=require('crypto');require('fs').writeFileSync('.data/fake-gh-app.pem',generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey)"
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   The second command prints the value for `MERGEPORT_ENCRYPTION_KEY`. Put this in `.env` (gitignored; both the app and the fake read it):

   ```
   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/mergeport"

   # Hosted mode, locally: the address you browse, behind the dev proxy of step 5.
   MERGEPORT_PUBLIC_URL="http://127.0.0.1:3100"
   MERGEPORT_TRUST_PROXY="true"

   # REQUIRED for the worker and the fake: the fake GitHub addresses below are ignored unless NODE_ENV is development (`next dev` sets it
   # itself; `npm run worker` does not, and without it renewing a linked account's token silently goes to the real github.com and fails).
   NODE_ENV="development"

   # The fake GitHub (development only).
   MERGEPORT_GITHUB_API_BASE="http://127.0.0.1:4010"
   MERGEPORT_GITHUB_WEB_BASE="http://127.0.0.1:4010"
   MERGEPORT_GITHUB_APP_ID="12345"
   MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE=".data/fake-gh-app.pem"
   MERGEPORT_GITHUB_APP_WEBHOOK_SECRET="dev-webhook-secret-0123456789"
   MERGEPORT_GITHUB_APP_CLIENT_ID="Iv1.devfakeclient01"
   MERGEPORT_GITHUB_APP_CLIENT_SECRET="dev-client-secret-0123456789abcdef"
   MERGEPORT_GITHUB_APP_SLUG="mergeport-dev"

   # Linking, sign-in with GitHub and writes need this (paste the printed value).
   MERGEPORT_ENCRYPTION_KEY="<64 hex characters from the command above>"
   MERGEPORT_GITHUB_WRITES="on"

   # The address of the verified GitHub email of the fake user. Use the SAME address in step 6.
   FAKE_GITHUB_EMAIL="you@example.test"
   ```

   Optional: `FAKE_GITHUB_PORT` (default 4010; change the two base variables to match) and `FAKE_GITHUB_LOGIN` (default `devuser`).

3. **Run the fake.** `npm run dev:github-fake`. It prints the installation id and the two base addresses. Leave it running.

4. **Run the app.** `npx next dev -H 127.0.0.1 -p 3101` (not `npm run dev`: that uses port 3000 and the proxy below fronts 3101). Optionally
   `npm run worker` in another terminal so repositories sync after you connect them.

5. **Run the proxy.** `npm run dev:proxy`. Hosted mode needs `X-Forwarded-For` from a proxy you control; this one listens on
   `http://127.0.0.1:3100`, forwards to 3101 with the Host unchanged and adds the client address. Browse **`http://127.0.0.1:3100`**, never 3101.

6. **Sign in with a magic link.** Open `http://127.0.0.1:3100/sign-in`, enter the address you put in `FAKE_GITHUB_EMAIL`, and take the link from the
   `next dev` console (no SMTP is configured, so the mail is printed there). Complete onboarding to create a workspace.

7. **Connect GitHub.** Settings, GitHub: choose to connect. The browser goes to the fake install page and straight back; the workspace is now
   bound to the `fake-org` installation. (Pick "I already have the App installed" to exercise the authorize page instead.) Then add the repositories
   (Connect repositories); with the worker running they sync, including the issues and pull requests.

8. **Link your GitHub account.** Settings, GitHub account: Link. You return linked as `devuser`.

9. **Sign in with GitHub.** Sign out, then on the sign-in page choose "Continue with GitHub". You come back signed in as the person whose verified
   primary email matches `FAKE_GITHUB_EMAIL` (the account you made in step 6).

10. **Enable writes and create an issue.** Settings, GitHub: turn on writes for the workspace (the server ceiling is `MERGEPORT_GITHUB_WRITES=on`).
    Create a task with "Also create a GitHub issue", pick `fake-org/private-repo`, confirm on the review screen. The fake records it:
    `http://127.0.0.1:4010/__fake/state` lists the write, authored by `devuser`.

## Notes

- "Connect GitHub" and "Link" send the browser to the fake with a plain navigation. The settings page opens an `http://127.0.0.1` or
  `http://localhost` address only outside a production build (`redirectOf` in `GithubConnectForms.tsx`); a production build opens https only.
- Symptom of a missing `NODE_ENV=development` in the worker's environment: the job `github.access.refresh` fails with "GitHub did not renew the
  sign-in", no repository access rows are written, and "Also create a GitHub issue" is never offered. The worker prints a warning at start.
- Same cause, second symptom: a worker that ran without `NODE_ENV=development` asked the REAL GitHub about the fake installation id, was told
  it does not exist, and recorded the installation as removed (`GithubInstallation.deletedAt`). Removed installations are skipped by the access
  refresh (no `/user/installations` call, zero `GithubRepoAccess` rows, the job still ends DONE). Fix: Settings, GitHub, "Check again" (it asks the
  fake and clears the mark), then trigger the refresh again (link again, or wait for the next scheduled run).
- State lives in the fake's memory: restarting it reseeds everything (installation and repository ids stay the same, so a bound workspace still
  works; issues you created are gone). Restart it freely.
- The fake's `devuser` is the only person the authorize page approves. It is an organisation owner, which is what the connect proof needs.
- A browser check (or Claude) can drive the same steps against `http://127.0.0.1:3100`; there is no real GitHub traffic at any point.
- If the app refuses to start with "Hosted configuration is incomplete", read the listed variable names: one of the App values is missing,
  or `NODE_ENV` is not `development` (use `next dev`, not `next start`).
