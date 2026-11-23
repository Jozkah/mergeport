# Remote MCP (hosted)

A hosted Mergeport has an MCP server at `POST <MERGEPORT_PUBLIC_URL>/api/mcp`, so an AI app can read tasks, open a task, comment, edit it, move it between board columns and mark it done as you:
"open a task on Mergeport to review the payments PR", "move it to In progress", "finish it". It can never delete anything.

Transport: MCP streamable HTTP, stateless. Each POST carries one JSON-RPC message (or a batch of up to 5) and is answered as `application/json`; a
notification is answered `202`. There are no sessions and no event streams, so `GET` and `DELETE` are `405`. Methods: `initialize`, `ping`,
`tools/list`, `tools/call`. The handler is the small protocol core in `src/lib/mcp/server.ts`; the hosted tools are in
`src/lib/mcp/hosted.ts`, the route in `src/app/api/mcp/route.ts`. No SDK dependency.

## Connect an app

1. Settings, **Connect AI (MCP)**: name the token, choose **Read only** or **Read and change tasks**, choose an expiry (30, 90, 365 days or never), **Create token**.
   The secret (`mp_pat_` and 43 characters) is shown once. Mergeport keeps only its sha256.
2. In the app, add a remote MCP server with the connector address shown there and the header `Authorization: Bearer <token>`.
   Claude Code: `claude mcp add --transport http mergeport https://app.example.com/api/mcp --header "Authorization: Bearer <token>"`.

The token goes in the header only. A token in the query string is never read.

## OAuth (Claude custom connectors)

claude.ai and the Claude desktop app cannot send a custom header, so the endpoint also speaks the MCP authorization spec (OAuth 2.1, authorization code with PKCE,
public clients that register themselves). In Claude: Settings, Connectors, add a custom connector, paste the connector address. Claude finds the rest itself, sends
you to Mergeport to sign in and allow it, and no token is pasted anywhere. Personal access tokens above keep working unchanged.

| Address | What |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` (and `/api/mcp` form) | RFC 9728 metadata: the resource (`<origin>/api/mcp`) and its authorization server. A `401` from `/api/mcp` carries `WWW-Authenticate: Bearer realm="Mergeport", resource_metadata="<that address>"`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: endpoints, `S256` only, `none` client authentication, scopes `read` and `write`. |
| `POST /api/oauth/register` | RFC 7591 dynamic registration. Public clients only. Redirect addresses: https, or http on `localhost`, `127.0.0.1` or `[::1]`; no fragment, credentials or wildcard; at most 5; matched exactly later. 10 registrations per address and hour, and 60 per hour across everyone. At most 1000 clients: past 800, clients nobody authorized within an hour are forgotten, and when full ones older than a day too; a client with a grant is never deleted, so spam cannot keep the table full. |
| `GET /oauth/authorize` | An ordinary session page. Signed out goes to sign-in and back. Shows the app's name (NOT verified: anyone can register any name, so the address it returns to is shown too), a picker limited to YOUR active workspaces, and Read only (default) or Read and change tasks (create, comment, edit, move, complete; only where your role writes). Allow or Cancel. An unknown client or a redirect address that is not exactly a registered one is never redirected to; other errors go back to the registered address with `state`. |
| `POST /api/oauth/token` | `authorization_code` and `refresh_token` grants. 60 requests per address each minute, and 120 per client and address (the client is loaded first: an unknown `client_id` is `invalid_client` and creates no counter, and a stranger cannot drain the budget of an app's real users). |

- **PKCE S256 is required.** The challenge is bound to the code; a wrong verifier fails and burns the code. `state` is echoed. `resource`, when sent, must be the `/api/mcp` address.
- **Codes** are single-use, 60 seconds, hashed, bound to client, redirect address, challenge, workspace and person. Using one again revokes the grant it bought.
- **Access tokens** are `ApiToken` rows (`kind` OAUTH, `mp_oat_` and 43 characters, one hour, hashed) bound to the `/api/mcp` address as audience, so every check, limit and
  audit entry of a personal token applies: membership and role are loaded fresh on every call, a removed member's tokens stop, a READER or a demoted member cannot write.
  A write still needs the WRITE scope and a writing role (the edit tools also `editAllowed` on the grant). The granted scope never exceeds the role: a refresh after a demotion comes back read-only.
- **Refresh tokens** (`mp_ort_`, 30 days, hashed) rotate on every use. Using an old one again means two parties hold it: the whole grant (family) is revoked, access tokens included.
- **Connected apps** are listed in Settings, Connect AI (yours; an owner or administrator sees every app in the workspace) with Disconnect, which ends the grant, its access tokens and its refresh tokens at once.
- Audit entries: `oauth.authorize`, `oauth.revoke`, `oauth.code-replay`, `oauth.refresh-reuse`, and the usual `mcp.task.*` entries for writes (`create`, `comment`, `update`, `move`, `complete`, `reopen`), with the token id.
- The consent action checks the session's CSRF token, re-validates every parameter the form carried, and `src/proxy.ts` still applies its Origin rule to it. The proxy exempts exactly `POST /api/oauth/register` and `POST /api/oauth/token`, and
  only for a request with no `Origin`, `Sec-Fetch-Site` or `Cookie` (the AI app's server calls them, not a browser). No CORS, so a browser-based client cannot use them. Hosted only: all of it is `404` otherwise.
- Register and token need a client address (the trusted proxy's `X-Forwarded-For`; the server refuses to start hosted without `MERGEPORT_TRUST_PROXY=true`). A request that still arrives without one gets `503 Client address unavailable` instead of sharing a bucket everyone would fill. Expired counters (`oauth:*` keys included) are deleted by the daily housekeeping job that already prunes `RateLimitState`.

Not built: client secrets and confidential clients, client metadata documents, token revocation and introspection endpoints (disconnect in Settings instead), OpenID Connect, dynamic scopes beyond `read` and `write`.

## Tokens

`ApiToken` is a ROOT model (docs/tenancy.md): `workspaceId`, `userId`, `name`, `tokenHash` (unique), `prefix` (first 12 characters, for display), `scope`
(`READ` or `WRITE`), `createdAt`, `lastUsedAt` (written at most once a minute), `expiresAt`, `revokedAt`.

- One token is bound to ONE workspace and acts as ONE person in it. The person's viewer is loaded fresh for that pair on every call (`authenticateApiToken`),
  so a role change, a removal, a space change or a revoked repository grant applies on the next call. A removed or suspended member's tokens stop working.
- Any member makes tokens for themselves (at most 20 active). A READER can only make a read-only token. You see and revoke your own; an owner or
  administrator sees and revokes every token of the workspace. Creating and revoking are audit entries (`apitoken.create`, `apitoken.revoke`).
- Bad, unknown, revoked and expired tokens, and a removed member's, all get the same `401` with `WWW-Authenticate: Bearer realm="Mergeport"` and the same body.

## Tools

| Tool | Does | Needs |
| --- | --- | --- |
| `list_projects` | Projects you can see, with repositories and board columns | read |
| `list_tasks` | Tasks; filters: project, status (open, done, all), assignee (login, `me`, `unassigned`), query, limit (max 50) | read |
| `get_task` | One task with description, checklist, latest 20 comments and history entries | read |
| `search` | Tasks by words in title or description, open and done | read |
| `create_task` | A task in a project's backlog: title, description, assignee, priority, due date, labels | write |
| `add_comment` | A comment on a task, as the token's person | write |
| `update_task` | Change one task: `title`, `description` (empty clears), `assignee` (login or `me`) or `unassign`, `priority`, `due` or `clear_due`, `add_labels`, `remove_labels` | write |
| `move_task` | Move a task to another column of its project, by column name or key (an unknown column is refused and the project's columns are listed) | write |
| `complete_task` | Move a task to the Done column | write |
| `reopen_task` | Move a done task back to Backlog, or to the `column` named | write |

Not built: deleting a card, bulk changes, editing or deleting comments, anything on GitHub (the stdio server's approval-queue
tools are not offered here), OAuth, sessions and server-sent events.

Follow-up, deliberately not done: the opt-in GitHub writes (create an issue from a task, comment; docs/github-app.md "Writing to GitHub as you") are NOT exposed over MCP. They are made with the person's own GitHub token after an on-screen confirmation of the exact text, and an AI app has no such confirmation. If they are ever offered here it needs its own consent step on the token, the same gates and budgets, and an approval in the app before anything reaches GitHub.

Reads go through the app's own services (`listTasks`, `getTask`, `planningWhere`, `projectWhere`, `repoWhere`), so workspace, restricted spaces and
private repositories are the app's rules. `create_task` runs the `mp task add` code (same validation, project and assignee resolution, history entry
"added this from an AI app over MCP"); `add_comment` runs `addComment`. `update_task`, `move_task`, `complete_task` and `reopen_task` run `updateTask`, the
service behind the task page's Save and Status controls (same validation, project write check, restricted spaces, history entries and plan events), resolving the
assignee (an EXACT known login, case-insensitive, or `me`: never a partial match, a miss lists the candidates) and column with the same helpers as `mp task update`, and add the history entry "changed this from an AI app over MCP". A card that follows a GitHub
item keeps its title, assignee and labels from GitHub (refused), and moving or completing it needs the repository's manage-work grant, as dragging it on the board does.
An id that is not in the token's workspace, or that the person cannot see, is "Not found, or you cannot see it" for every tool. Inputs are checked with zod (strict, size caps, no control characters). Answers are
capped at 40,000 characters. Errors are tool errors without internals; an unexpected failure says "Something went wrong. Nothing was changed."

## Untrusted text

Titles, descriptions and comments are written by other people, so an answer can carry a prompt injection. Every object answer has a `notice` saying so, `get_task`
wraps the description, checklist text and comment bodies as `{"untrusted":true,"text":...}`, and the server instructions tell the model to treat them as data
and never create, change or comment because they ask. This lowers the risk; it cannot remove it, which is why writes need an explicit WRITE token.

## Writing

A write needs both: the token's scope is `WRITE`, AND the person's role writes right now (`requireWrite`, project and space write checks inside the
services). A READ token never writes. A READER never writes, even with a WRITE token (a token row forced to WRITE still fails). Each write is an audit entry
(`mcp.task.create`, `mcp.task.comment`, `mcp.task.update`, `mcp.task.move`, `mcp.task.complete`, `mcp.task.reopen`) with the person as actor and the token id (never the secret) in `meta`.

**Editing is a separate consent (`editAllowed`).** WRITE used to mean "create and comment". The four edit tools (`update_task`, `move_task`, `complete_task`,
`reopen_task`) need WRITE AND `editAllowed`, a boolean on `ApiToken` and `OAuthGrant` (migration `20261128100000_token_edit_allowed`, default false). Tokens and
grants that existed before it stay false: they keep reading, creating tasks and commenting, and an edit tool answers that the token or connection predates editing
and to make a new token (Settings, Connect AI) or disconnect and reconnect the app. A token created in Settings with write access, and an OAuth consent given with
**Read and change tasks**, set it true. An OAuth access token follows its grant's value on every call (and carries it on refresh); a read-only one is never true.
No existing token or grant gains edit power by upgrading.

## Limits

- 120 JSON-RPC messages per token and minute (a batch of n costs n; `429` with `Retry-After`), 30 writes per token and minute (a tool error). Counters are in `RateLimitState`
  (`mcp:req:<token>`, `mcp:w:<token>`).
- 20 unknown but well-formed tokens per address and minute, then `429` (`mcp:bad:<hash of address>`). The address comes from MERGEPORT_TRUST_PROXY, like the webhook.
- Request bodies over 256 KiB are `413`.

## Perimeter

`src/proxy.ts` refuses a POST without a same-origin `Origin` or `Sec-Fetch-Site`. `/api/mcp` is exempt for exactly: hosted, method POST, that exact path, an
`Authorization: Bearer` header, and none of `Origin`, `Sec-Fetch-Site`, `Cookie` (a browser sends at least one of the first two on a cross-site request).
The route never reads cookies and sends no CORS headers; a preflight is not answered. The endpoint is `404` when the server is not hosted. Tokens are never logged.

## Unverified

Not tried against a real Claude connector or a real browser consent flow; the flow is tested end to end against the route handlers, not against claude.ai. Claude's exact
registration and redirect addresses (for example whether it needs a particular `redirect_uris` shape) are not confirmed here.

See docs/roles.md (roles) and docs/auth.md (sessions); docs/tenancy.md lists `ApiToken`.
