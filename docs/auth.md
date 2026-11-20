# Accounts and sign-in (hosted)

A hosted deployment lets people without GitHub sign in by **email link** or **OpenID Connect** (Google, Microsoft, any standard
provider). The local app keeps its GitHub CLI sign-in; nothing here changes it.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `MERGEPORT_PUBLIC_URL` | `https://app.example.com`. Turns on hosted mode: the host guard (`src/proxy.ts`) also accepts this host, `/sign-in` shows the account page instead of the gh/hub/demo sections, session cookies are `Secure` when the URL is https, links and redirects use it. To try hosted mode locally set it to `http://127.0.0.1:3000`. |
| `SMTP_URL`, `MAIL_FROM` | Outgoing mail (nodemailer), e.g. `smtps://user:pass@smtp.example:465`. Both are needed. |
| `OIDC_<NAME>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | One provider per `<NAME>` (`GOOGLE`, `MICROSOFT`, ...). All three or the provider is ignored. Redirect URI to register: `<public url>/auth/oidc/<name>/callback`. |
| `MERGEPORT_AUTH_SECRET` | 32+ random characters. Signs the short-lived OIDC flow cookie. Required when an OIDC provider is configured. |
| `MERGEPORT_TRUST_PROXY=true` | Only behind a reverse proxy you control: the last `X-Forwarded-For` entry is then the client address for the per-address limit. Without it that limit is skipped (the per-email and server-wide limits still apply). |

Microsoft: use the tenant-specific issuer (`https://login.microsoftonline.com/<tenant-id>/v2.0`); the multi-tenant `common`
issuer does not match the ID token's issuer. Microsoft ID tokens carry no `email_verified`, so Microsoft logins are never linked
by email (see Linking).

Mail transport: with no `SMTP_URL`, development prints the message, link included, to the server console. **Production never does
that.** Without SMTP it refuses: the sign-in page says email sign-in is not set up and no link is created or logged.

## Data

- `User.githubId` is nullable (still unique when present). `email` is unique, always lowercase (a CHECK enforces it), `emailVerifiedAt`
  records proof. Legacy GitHub users keep `githubId` and have a null email; nothing was backfilled.
- `Identity(provider, subject)`, unique: `email` (subject = the address), `oidc:<name>` (subject = the provider's `sub`), `github` (later).
- `MagicLink`: lowercased address, SHA-256 of the token (the token itself is never stored), `expiresAt` (15 min), `consumedAt`, hashed IP.
- Rate limits are rows in `RateLimitState` with an `auth:` key prefix and hashed values, one atomic upsert per check.
- Code that assumed every user has a GitHub id (local profile, runner binding, discovery) now selects only users that do.

## Flows

**Email.** `POST /auth/magic/request` (same-origin form) -> `GET /auth/magic/callback?token=...`. Sign-up and sign-in are the same
step: an unknown address gets an account when its link is opened. The response is identical for known, unknown and rate-limited
addresses. Limits per hour: 5 per address, 20 per client address, 600 per server. Tokens are 32 random bytes (base64url). The link is
consumed by one `UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now RETURNING`, in the same transaction that upserts the user
and identity, so concurrent opens produce exactly one session. Known trade-off: a mail scanner that opens links before the person
does will use the link up; the person asks for another.

**OIDC.** `GET /auth/oidc/<name>/start` -> provider -> `GET /auth/oidc/<name>/callback`. Authorization code with PKCE (S256), `state`
and `nonce`, all kept in an HttpOnly, SameSite=Lax, HMAC-signed cookie that lasts 10 minutes and is deleted on first use. State and
nonce are compared in constant time by our code in addition to the library's own checks.

**After sign-in.** A person in no workspace goes to `/onboarding` (name -> `Workspace` + `Member` ADMIN/ACTIVE; the owner role comes
later). People with several workspaces get a switcher in the top bar.

## Library: `openid-client` 6.8.8

Chosen over `arctic` because the ID token must be *verified*, not merely decoded: openid-client does discovery, JWKS fetching,
signature, `iss`, `aud`, `exp`, `nonce` and state checks and is OpenID-certified; arctic leaves ID-token validation to the caller.
It is maintained by the author of `jose`/`oauth4webapi`, has no runtime dependencies beyond them, and 6.8.8 is more than two months
old. Exact versions are pinned (`openid-client` 6.8.8, `nodemailer` 10.3.1, `@types/nodemailer` 8.0.2). `src/lib/auth/oidc.ts` wraps it
behind a small `OidcProtocol` interface so tests can replace it.

## Linking and account takeover

Email is an unreliable identifier unless someone proved they own it, so:

1. A provider `sub` we have seen before always resolves to the same user. The email is never consulted again.
2. A *verified* email (`email_verified` is `true` or `"true"`; missing or anything else is unverified) that an existing user holds
   **and has verified** gets the new identity attached to that user.
3. If the holder never verified the address (it was typed in, not proved), it is **not** merged. The verified owner gets a new account;
   the stale claim is removed from the old one. Merging would hand whoever registered an address first the real owner's later logins.
4. An unverified or missing email creates a new user with no email. It is kept on the identity for display only, never for linking.
5. Legacy GitHub users have no email and are never matched by it.

In this phase every stored email is verified (magic link or `email_verified`), so rule 3 guards against future code paths and data
imported with unverified addresses. A magic link also verifies a holder's address, which is safe because opening it proves the inbox.

## Sessions and the workspace

Sessions are the existing opaque, server-side ones (only the SHA-256 of the cookie is stored; 180 days). Hosted cookies: HttpOnly,
SameSite=Lax (the email and OIDC arrivals are top-level cross-site navigations and Strict would drop the cookie on the next request),
Secure when the public URL is https. Every login creates a new token and destroys the session the browser arrived with (fixation).
Sign-out (`POST /auth/signout`) deletes the row.

**Workspace binding.** `Session.activeWorkspaceId` (nullable, FK to Workspace, `ON DELETE SET NULL`) records the switcher's choice. Chosen
over the `mp_ws` cookie because the binding then lives with the login: it dies with the session, cannot be set by another page or
tab, and a stolen cookie value cannot name a workspace. It is still only a *preference*: `resolveActiveWorkspaceId` re-checks an ACTIVE
membership on every request, so revoking a member takes effect on their next request and they fall back to another workspace or
onboarding. `selectWorkspace` accepts only workspaces the person is an ACTIVE member of. `mp_ws` is kept as a fallback for sessions
that have no binding.

## Security checklist

| Item | Where |
| --- | --- |
| CSRF on state-changing requests | `proxy.ts` and each route (`sameOrigin`) require same-origin Origin/Sec-Fetch-Site; the onboarding and switcher forms are Server Actions (Next checks Origin against Host) |
| Open redirect | `safeReturnTo`: relative paths only; rejects `//`, backslash and any control character. Applied when the link is made, in the OIDC cookie, and at redirect time |
| No token or email in logs | Delivery failure logs a fixed message; library errors are swallowed; the dev console transport is the only place a link is printed and it is refused in production |
| Timing-safe compares | `safeEqual` for state, nonce and the cookie signature; token lookup is by hash |
| Session fixation | new random token per login, previous session destroyed |
| Logout | server-side row deleted |
| Replay / expiry | single-use atomic consume, 15 minutes |
| Rate limits | database rows, atomic |
| Email normalization | lowercase, trim, ASCII only; plus-addressing kept distinct |

## Not done here

Invitations, owner and other roles, GitHub OAuth/App sign-in (`github` identity provider is reserved), SSO/SAML, a limit on how many
workspaces one person may create, and email change. The existing `/api/local/*` routes keep refusing non-loopback hosts.
