# Federation: linking two Mergeport instances

A person can link another Mergeport instance to their own and see that instance's projects, **read-only**, inside their own. The data
stays stored on, and is authorized by, the instance that owns it. Federation is off everywhere by default and exists only on a hosted
instance (it needs a public https origin); a local instance hides it.

Every instance is both ends:

- **Consumer (A)**: where the person lives and looks. Holds one encrypted token per link and a short-lived cache.
- **Provider (B)**: owns the data. Issues revocable read-only grants and checks them on every request.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `MERGEPORT_FEDERATION` | The operator **ceiling**: `off` (default), `allowlist` or `any`. Off means federation does not exist: every route, page and action answers 404. |
| `MERGEPORT_FEDERATION_ALLOWLIST` | Comma separated origins, used when the ceiling is `allowlist`. |
| `MERGEPORT_ENCRYPTION_KEY` | At least 32 bytes of key material: 64 hex characters, base64 of 32 or more bytes, or a passphrase of 32 or more characters (exactly 32 bytes are used as they are, anything longer is hashed to 32). Required when the ceiling is not `off`; it encrypts peer tokens (AES-256-GCM, bound to the link row). Without a valid key federation stays absent and Settings says why. **Rotating it makes every stored token undecryptable: people must unlink and link again.** |
| `MERGEPORT_FEDERATION_ALLOW_INSECURE=1` | http and loopback targets, for development and tests only. Ignored when `NODE_ENV=production`. |

Per workspace (owner and admins, Settings, Linked instances), always inside the ceiling:

| Setting | Meaning |
| --- | --- |
| Outgoing mode `off / allowlist / any` | May people here link other instances? |
| Incoming mode `off / allowlist / any` | May other instances link to this workspace? |
| Allow list | Origins for the `allowlist` modes. |
| Who can link | Owner and admins, or members too. Readers never. |
| Links per person | 0 to 50. Counts the person's pending and active links. |
| Linked instances | 0 to 50 distinct peers with an ACTIVE link; 1 = a single linked instance. |

The limits are checked at start (for a quick answer) and again **when a link is activated**, inside a transaction that holds a
per-workspace advisory lock, counting the other ACTIVE links. Concurrent starts can therefore all begin, but only as many as the limit
allows become active: the others are refused, their token is handed back to the peer and nothing is stored.

Both the ceiling and the workspace must say yes, so a workspace set to `any` is still limited by a ceiling `allowlist`, and a workspace
is never looser than the server. **The policy is evaluated on every request**: creating a link, approving, using a token, serving or
refreshing the cache. Turning something off, or removing an origin from a list, stops existing links at once; turning it on again
resumes them (the token is not destroyed by a policy change, only by unlinking, revoking or expiry).

## Flow

1. **A: start.** The person enters B's address. A normalises it to an https origin, checks who may link, the outgoing policy and the
   limits, fetches `B/.well-known/mergeport-federation` through the safe fetcher (version and a hint only; endpoints are derived from
   the origin), stores a one-use `state` (hash only) and an encrypted PKCE verifier on a PENDING link, and redirects the browser to
   `B/federation/authorize?client_origin&redirect_uri&state&code_challenge&code_challenge_method=S256&scope=read`.
2. **B: consent.** B requires a signed-in user, validates the request (`redirect_uri` must equal exactly
   `<client_origin>/federation/callback`; a bad request is an error page, never a redirect), checks the incoming policy per workspace,
   and shows "<A> wants read-only access to your <workspace> projects as you" with a workspace picker, what read-only includes and
   what it never includes. Approve is a POST (server action, Origin rules, session CSRF token). It stores a one-time code (sha256, 60 s,
   bound to challenge, redirect_uri, client, user, workspace) and sends the browser to A's callback with `code` and `state`.
3. **A: callback.** The `state` must belong to a PENDING link of the person signed in on A and is cleared on first use. A then POSTs
   `{code, code_verifier, redirect_uri, client_origin}` to `B/api/federation/v1/token` (safe fetch, server to server). B burns the
   code before judging it: a wrong verifier, wrong redirect, wrong client, expired code or a policy refusal all invalidate it; a second
   presentation revokes the token the first produced. B returns an opaque token (32 random bytes, base64url). B stores only its sha256;
   A stores it AES-256-GCM encrypted. The callback answers with a redirect to `/linked?result=<code>`, so no code or state stays in the
   address bar or is ever reflected.
4. **Use.** A calls B's read API with the bearer token. B: per-address limit, token to grant, policy, then
   `loadViewer(grant.user, grant.workspace)` and the same `projectWhere` / `planningWhere` as the person's own pages, so roles,
   project membership, repository access and restricted spaces apply unchanged. Token life: 30 days sliding, 180 at most.
5. **End.** Removing a person from a workspace, or their leaving, revokes the grants they approved and ends their links (token deleted, cache cleared); a reinstated person must approve again. Lowering a role (or an ownership transfer demoting the old owner) revokes that person's grants, because consent was given at the higher role. Unlink on A deletes the token and the cache, then tells B best effort. On B the person (Linked apps) revokes their own
   grants, and administrators see every grant of the workspace with Revoke and "Revoke all from <origin>".

## Provider API (bearer token, JSON, GET)

`/api/federation/v1/me`, `/projects`, `/projects/:id` (columns and card summaries, at most 500 cards), `/projects/:id/tasks`
(`?limit` up to 100, `?cursor`). Plus `POST /token` and `POST /revoke` (server to server; `proxy.ts` exempts exactly these two paths from
the browser Origin rule because they carry no cookie) and `GET /.well-known/mergeport-federation`.
Answers are built field by field (no Prisma row is returned), carry an `ETag` and honour `If-None-Match`. A bad, revoked, expired,
policy-blocked or de-membered token is one identical 401; a hidden and a missing resource are one identical 404; limits are 120 per
minute per grant, 600 per minute per address for reads, 30 per minute per address for the token endpoint.

## Untrusted answers

The consumer parses every peer answer against strict zod shapes (`src/lib/federation/schemas.ts`) before caching or rendering: unknown
fields are dropped, strings and arrays are capped, ids must match `[A-Za-z0-9_-]{1,60}`. A body that does not fit is an error state, is
not cached, and the last good copy (if any) keeps showing. Revoking is never blocked by being switched off: unlinking and revoking a
grant work when the ceiling is off or the key is missing, and `/linked` then appears only to someone who still holds a link or grant.

## Safe fetcher (`src/lib/federation/safe-fetch.ts`)

The only code that fetches an address a person typed. https only; DNS resolved in-process, every answer checked, the socket pinned
to the checked address (rebinding cannot move it); refuses loopback, private, link-local (cloud metadata), CGNAT, multicast, reserved
and documentation ranges for IPv4, IPv6 and IPv4-in-IPv6; no redirects at all (a 3xx other than 304 is an error); no cookies in or out;
only the default https port outside development (no port scanning through error messages); also refuses 64:ff9b:1::/48 and the SIIT range ::ffff:0:0:0/96; connect 5 s, total 10 s, 2 MB cap, `application/json` required. No new dependency: Node's `dns`, `http` and `https`.

## Threat model

| Threat | Answer |
| --- | --- |
| A stranger links to my instance | Ceiling off by default; per workspace incoming `off` by default; allow lists; per-person consent. |
| SSRF through the address field | Safe fetcher above; nothing else fetches user-supplied URLs. |
| Open redirect on the consent page | The return address is rebuilt from `client_origin` and compared exactly; it is never taken as given. |
| Code or token theft | Code: 60 s, one use, PKCE S256, bound to redirect and client; tokens hashed at rest on B, encrypted on A; never logged, never in a URL after the exchange. |
| Callback pushed at someone else's browser | The state is bound to the pending link of the signed-in person. |
| CSRF on Approve | Server action origin check, proxy Origin rules (`Origin: null` only with `Sec-Fetch-Site: same-origin`), session CSRF token. |
| Clickjacking the consent page | CSP `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| Cross-tenant read | Grant is bound to one workspace; every read goes through `loadViewer` for it; tests read another workspace's project id with a valid grant and get 404. |
| A linked instance writing here | There is no write route; the scope is `read`. |
| Linked data leaking into my instance | Cache rows are per link and per person, never read by search, digests, AI, backup or export (a test greps the source). |
| Replay after revoke | Checked on every call; unlink, user revoke, admin revoke, expiry, policy off and membership loss are all 401 on the next request. |

## What is NOT shared

Email addresses, GitHub credentials or data, hub and sync state, sessions, settings, other workspaces, other people's accounts, projects
the granting person cannot see (including restricted spaces they are not in), and any ability to change anything. Also out of scope:
write-through edits, pushing snapshots to colleagues, server-to-server instance trust, GitHub data federation, push updates (the
linked pages poll every 45 s while open).

## Not verified

Run only through the unit and integration tests (two simulated instances in one database, real sockets for the fetcher on loopback).
No browser run, no real second deployment, no DNS or TLS against a real peer.
