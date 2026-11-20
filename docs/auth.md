# Accounts and sign-in (hosted)

A hosted deployment lets people without GitHub sign in by **email link** or **OpenID Connect** (Google, Microsoft, any standard
provider). The local app keeps its GitHub CLI sign-in; nothing here changes it.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `MERGEPORT_PUBLIC_URL` | `https://app.example.com`. Turns on hosted mode (below). To try it locally set `http://127.0.0.1:3000`. |
| `MERGEPORT_TRUST_PROXY=true` | **Required when hosted.** You run behind a reverse proxy you control that appends the client address to `X-Forwarded-For`. Without it the server refuses to start and sign-in answers 503: there would be no client address to rate-limit on. |
| `MERGEPORT_TRUSTED_PROXY_HOPS` | Number of proxies you operate in front of the app (default 1). The client address is the Nth entry from the **right** of `X-Forwarded-For`; entries to its left are what the client claimed and are ignored. Fewer entries than hops means no address and the request is refused. |
| `SMTP_URL`, `MAIL_FROM` | Outgoing mail (nodemailer), e.g. `smtps://user:pass@smtp.example:465`. Both are needed. |
| `OIDC_<NAME>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | One provider per `<NAME>` (`GOOGLE`, `MICROSOFT`, ...). All three or the provider is ignored. Redirect URI to register: `<public url>/auth/oidc/<name>/callback`. |
| `MERGEPORT_AUTH_SECRET` | 32+ random characters. Signs the short-lived OIDC flow cookie. Required when an OIDC provider is configured. |
| `MERGEPORT_SESSION_DAYS` | Hosted idle session lifetime, 1 to 180 (default 30). |

Hosted mode means:

- `src/proxy.ts` accepts **only** the public host. A loopback Host is refused (a reverse proxy can forward a client's own
  `Host: 127.0.0.1`); the one exception is the launcher's `GET /api/local/ready` probe.
- Every `/api/local/*` route answers 404 (in the proxy and again in each route handler), except `POST /api/local/signout`. The
  local gh sign-in, launcher links, demo sign-in and hub connect do not exist on a hosted server. `/api/local/signin` also requires a
  loopback Host with the right port even in the local app.
- `/sign-in` shows the account page; session cookies are `Secure` when the URL is https; redirects and links use the public URL.
- `serverActions.allowedOrigins` in `next.config.ts` names the public host, so the onboarding, workspace-switcher and sign-out-everywhere
  forms work behind a proxy that rewrites `Host` (the browser's Origin is the public host; Next compares it with the host it sees).
  Set the variable at build and start time.

Microsoft: use the tenant-specific issuer (`https://login.microsoftonline.com/<tenant-id>/v2.0`); the multi-tenant `common` issuer does
not match the ID token's issuer. Microsoft ID tokens carry no `email_verified`, so Microsoft logins are never linked by email.

Mail transport: with no `SMTP_URL`, development prints the message, link included, to the server console. The console transport is
refused when `NODE_ENV=production` **and** whenever the public URL is https, so a hosted server never writes sign-in links to its log;
without SMTP it says email sign-in is not set up and creates no link.

## Data

- `User.githubId` is nullable (still unique when present). `email` is unique, always lowercase (a CHECK enforces it), `emailVerifiedAt`
  records proof. Legacy GitHub users keep `githubId` and have a null email; nothing was backfilled.
- `Identity(provider, subject)`, unique: `email` (subject = the address), `oidc:<name>` (subject = the provider's `sub`), `github` (later).
- `MagicLink`: lowercased address, SHA-256 of the token and of the requesting browser's value (neither is stored raw), `expiresAt`
  (15 min, indexed), `consumedAt`, hashed IP.
- Rate limits are rows in `RateLimitState` with an `auth:` key prefix and hashed values, one atomic statement per check.
- Code that assumed every user has a GitHub id (local profile, runner binding, discovery) now selects only users that do.

## Email flow

`POST /auth/magic/request` (same-origin form) -> `GET /auth/magic/callback?token=...`. Sign-up and sign-in are the same step: an unknown
address gets an account when its link is opened. The response is identical for known, unknown and rate-limited addresses. Tokens are 32
random bytes (base64url). The link is consumed by one `UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now AND browserHash = ...
RETURNING`, in the same transaction that upserts the user and identity, so concurrent opens produce exactly one session.

**Bound to the browser.** The request sets an HttpOnly, SameSite=Lax cookie (`mp_ml`, path `/auth/magic`, 15 min) with a random value
and stores its hash on the link; the callback compares it in constant time. From any other browser, or from a mail scanner that opens
the link first, nothing is consumed and the person is told to use the browser they asked from. This defeats login CSRF (an attacker
mailing their own link to the victim) and scanner consumption. A second request from the same browser reuses the value, so the first
link keeps working. Cost: a link opened in a different browser or a private window does not work; the person asks again.

**Limits** (all counted in the database; a refused call is never counted, so hammering a full bucket changes nothing):

1. per client address: 20 requests an hour (any addresses);
2. server-wide: 2000 an hour, a backstop, counted only after the client check passes (one client can use at most 20 of it; it logs once when reached);
3. per (address, client): 5 an hour, so an attacker can exhaust only their own budget for a victim's address;
4. per address: one mail per minute whoever asks, checked last. A refused request never moves the slot, and the (address, client) check
   comes first, so a client that is out of budget cannot keep the slot occupied.

Consequences: a victim can be mailed at most once a minute (and each mail carries a working link, so they are not locked out; the cost
is inbox noise bounded by that rate), and there is no way to block someone from signing in beyond the minute the slot is taken.

## OIDC

`GET /auth/oidc/<name>/start` -> provider -> `GET /auth/oidc/<name>/callback`. Authorization code with PKCE (S256), `state` and `nonce`,
all kept in an HttpOnly, SameSite=Lax, HMAC-signed cookie that lasts 10 minutes and is deleted on first use. State and nonce are compared
in constant time by our code in addition to the library's own checks.

After sign-in a person in no workspace goes to `/onboarding` (name -> `Workspace` + `Member` ADMIN/ACTIVE; the owner role comes later).
People with several workspaces get a switcher in the top bar.

### Library: `openid-client` 6.8.8

Chosen over `arctic` because the ID token must be *verified*, not merely decoded: openid-client does discovery, JWKS fetching,
signature, `iss`, `aud`, `exp`, `nonce` and state checks and is OpenID-certified; arctic leaves ID-token validation to the caller. It is
maintained by the author of `jose`/`oauth4webapi`, and 6.8.8 is more than two months old. Exact versions are pinned (`openid-client`
6.8.8, `nodemailer` 10.3.1, `@types/nodemailer` 8.0.2). `src/lib/auth/oidc.ts` wraps it behind a small `OidcProtocol` interface so
tests can replace it.

### Linking and account takeover

Email is an unreliable identifier unless someone proved they own it, so:

1. A provider `sub` we have seen before always resolves to the same user. The email is never consulted again.
2. A *verified* email (`email_verified` is `true` or `"true"`; missing or anything else is unverified) that an existing user holds
   **and has verified** gets the new identity attached to that user.
3. If the holder never verified the address (it was typed in, not proved), it is **not** merged. The verified owner gets a new account;
   the stale claim is removed from the old one. Merging would hand whoever registered an address first the real owner's later logins.
4. An unverified or missing email creates a new user with no email. It is kept on the identity for display only, never for linking.
5. Legacy GitHub users have no email and are never matched by it.

In this phase every stored email is verified (magic link or `email_verified`), so rule 3 guards against future code paths and imported
data. A magic link also verifies a holder's address, which is safe because opening it proves the inbox.

## Sessions and the workspace

Sessions are opaque and server-side (only the SHA-256 of the cookie is stored). **Hosted: 30 days idle (`MERGEPORT_SESSION_DAYS`),
sliding**: a session in use is extended to now + the window, at most once an hour, and never past 180 days after sign-in. The browser
cookie is set for 180 days so the server's sliding expiry is what decides. **Local app: fixed 180 days, unchanged.** Cookies: HttpOnly,
SameSite=Lax (the email and OIDC arrivals are top-level cross-site navigations and Strict would drop the cookie on the next request),
Secure when the public URL is https. Every login creates a new token and destroys the session the browser arrived with (fixation).
`POST /auth/signout` deletes the row; the top bar's "All devices" button (`signOutEverywhereAction`) deletes every session of the person.

**Workspace binding.** `Session.activeWorkspaceId` (nullable, FK to Workspace, `ON DELETE SET NULL`) records the switcher's choice.
Chosen over the `mp_ws` cookie because the binding lives with the login: it dies with the session and cannot be set from another tab.
It is still only a *preference*: `resolveActiveWorkspaceId` re-checks an ACTIVE membership on every request, so revoking a member takes
effect on their next request. `selectWorkspace` accepts only workspaces the person is an ACTIVE member of. `mp_ws` stays as a fallback.

## Invitations (join without GitHub)

An OWNER or ADMIN invites an address from Settings > Members (`/settings/members`). Roles and who may invite: `docs/roles.md`.

- `Invitation`: workspace, lowercased address, role (never OWNER: a CHECK), inviter, SHA-256 of a 32-byte random token (the token is
  only in the mail), `expiresAt` (7 days), `acceptedAt`, `revokedAt`. One pending row per (workspace, address): a partial unique index;
  inviting an address again replaces the pending row, so the old link dies. Resend gives the same row a new token.
- The mail (`invitationMail`, plain text, sent through the same `Mailer` as sign-in links) links to `/invite/<token>`. **A GET changes
  nothing**: the page shows the workspace and role, and for the right person a Join button (a POST server action, so a mail scanner
  cannot use the link up). Missing, used, revoked and expired tokens all show the same "not valid" page.
- **The invited address is the identity proof.** Accepting needs a signed-in user whose `email` equals the invited address AND whose
  `emailVerifiedAt` is set. Not signed in: the page offers a magic link to that address (the form's `next` is the invite URL; opening
  the link proves the inbox) and any configured OIDC provider (the provider must send a verified email: unverified or missing claims
  never set `User.email`). Signed in with another address, or with a GitHub-only account that has no verified email: a clear error,
  nothing joined, and the offer to sign in with the invited address. Existing GitHub-linked users join the same way.
- Accept is one `UPDATE "Invitation" ... WHERE acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now RETURNING` plus the member
  insert in one transaction: of any number of simultaneous accepts exactly one claims the row; the same person pressing twice gets
  "already a member". Someone removed after the invitation went out is not re-admitted by it (the claim rolls back); an administrator
  reinstates them on purpose. `landingPath` keeps an `/invite/<token>` destination through sign-in for people with no workspace yet.
- Signing up never joins anyone, and being invited creates no account.
- **No user-existence leak.** Inviting an address that belongs to someone in another workspace, or to nobody, gives the admin the same
  answer and the same mail. The sign-in request keeps its uniform answer. (An admin is told "already a member" for their own workspace's
  members: the member list shows that anyway.)
- **Limits** (`rate-limit.ts` rows, keys `inv:`): 20 invitations per admin per hour, 100 per workspace per day, one mail per
  (workspace, address) per minute (invite and resend share it). A failed delivery withdraws the invitation (nothing is logged but the fact).
- Audit: `invitation.created/resent/revoked/accepted`.

## Hosted: no GitHub yet (fail-closed list)

The server's `gh` login belongs to whoever installed it, not to a workspace. Until the GitHub App phase gives each workspace its own
connection, a hosted deployment never uses it. `GithubNotConnectedError` ("GitHub is not connected for this workspace (arrives with the
GitHub App phase).") is thrown, or the path returns nothing, at:

- the gh process runner itself (`exec.ts`: no process is ever spawned), `currentGhStatus`, `credentialHelper`, `assertActiveAccount`, the sign-in "start gh login" action;
- the profile runner and `profileFetch` (both transports), `ghPort`, `portForSync`, `portForWrite`, `portForDiscovery` (so discovery, tracking, the watchlist action, work-item writes and the repository watcher);
- remote git (`clone`, `fetch`, `push`) in the updater's git writer;
- `localActor()` returns null, so no sync engine or team service is built; `checkProfile()` answers `hosted` (never asks gh, never shows the server owner's login);
- scheduler: `sync.repository`, `sync.item`, `sync.fork`, `upstream.update`, release checks and `reconcile.all` finish as no-ops (job DONE, not failed or retried); the coordination lane only schedules the local-only digest and AI jobs.

Server actions report the message instead of "something went wrong", and the app shows it in a banner. No GitHub App integration exists yet.

## Security checklist

| Item | Where |
| --- | --- |
| Hosted perimeter | proxy accepts only the public host; `/api/local/*` 404 (proxy and each handler) |
| CSRF | `proxy.ts` and each route (`sameOrigin`); the forms are Server Actions (Next checks Origin against Host / `allowedOrigins`); the magic link is bound to the requesting browser |
| Open redirect | `safeReturnTo`: relative paths only; rejects `//`, backslash and any control character |
| No token or email in logs | delivery failure logs a fixed message; library errors are swallowed; the console transport is refused in production and on https |
| Timing-safe compares | `safeEqual` for state, nonce, browser value and cookie signature; token lookup is by hash |
| Session fixation / logout | new random token per login, previous session destroyed; sign-out and sign-out-everywhere delete rows |
| Replay / expiry | single-use atomic consume, 15 minutes (invitations: 7 days, single-use, same pattern) |
| Invitation identity | accept needs the signed-in user's VERIFIED email to equal the invited address; join is a POST, never a GET |
| Rate limits / lockout | database rows, atomic, refused calls uncounted, per-(address, client) budget, 1 mail a minute per address |
| Email normalization | lowercase, trim, ASCII only; plus-addressing kept distinct |

## Not done here

GitHub OAuth/App sign-in (`github` identity provider is reserved) and per-workspace GitHub
credentials, SSO/SAML, a limit on how many workspaces one person may create, and email change.
