# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the written implementation briefs (no interview round; the briefs answer users, purpose and constraints in detail). Items marked **[assumed]** are not user-confirmed.

## Platform

web: a hosted, multi-tenant application. One deployment serves many workspaces from one PostgreSQL database; people sign in with a magic link or OIDC. A development run (`npm run dev`, `npm run demo`) serves 127.0.0.1 only.

## Stack

TypeScript, Next.js App Router, PostgreSQL through Prisma (pg adapter) with SQL migrations, Tailwind CSS, Octokit with a GitHub App (installation tokens, user-to-server tokens for per-person access, signed webhooks), a separate worker process for background jobs (`npm run worker`), Lucide, dnd-kit, GSAP for the few layout animations CSS cannot express. Optional: federation between instances (read-only project links), a remote MCP endpoint with personal access tokens and OAuth.

## Users

- **Workspace owner / admin**: creates the workspace, installs the GitHub App, chooses which repositories are tracked, invites members and sets roles (owner, admin, member, reader).
- **Member**: signs in, sees the repositories and projects their workspace role and GitHub access allow, plans work, reviews pull requests and keeps internal tasks.
- **Reader**: read-only access to what they are granted.
- **External reviewer** (tracked, not a member): a GitHub user or team whose review other work waits on.
- **AI app**: acts for a person through the MCP endpoint, with that person's rights and no way to change GitHub by itself.

## Product Purpose

A shared control center for selected GitHub repositories: attention queues (needs my review vs waiting on others), planning across repos, and fork/upstream intelligence. Success: nobody opens GitHub to find out what needs them, who they are waiting on, or what blocks whom.

## Positioning

GitHub stays the source of truth for issues, pull requests, reviews and labels, read through the workspace's GitHub App installation and each person's own linked access. Mergeport owns the planning data (projects, boards, internal tasks, routing rules, waiting annotations) and keeps it per workspace. Review-waiting is its own workflow dimension; fork/upstream status shows honest evidence levels instead of guesses.

## Operating Context

A hosted service for teams, many workspaces per deployment. Repository data is refreshed from GitHub in the background (webhooks and a worker), so pages render from stored data with its age and never wait on GitHub. Demo mode (synthetic data, no GitHub) is separate from connected mode and runs on the same Postgres (`npm run demo`).

## Capabilities and Constraints

- Access model: every query is scoped to one workspace (`docs/tenancy.md`); visibility inside it follows the viewer's role and GitHub access, evaluated per request, never by hiding rows in the UI. Roles live in the database and are changed only by an admin.
- Credentials: the GitHub App private key, webhook secret and encryption key are server configuration; a person's GitHub tokens are stored encrypted and never reach the browser, logs or exports. Nothing fetched from a repository is ever executed or installed.
- Server-side authorization on every resource; scoped counts and search; non-leaking not-found.
- No real GitHub mutations, repository creation or invitations to demonstrate features; live checks need an explicitly approved disposable target.
- Do not infer account types (e.g. `northwind`) by name; fixtures with that owner are synthetic.
- Out of scope: billing, chat, code editor, Projects v2 sync, anything on a person's own computer (local clones, worktrees, the GitHub CLI), peer-to-peer sync, syncing database files.

## Evidence on Hand

No real data, customers or metrics. All demo data is synthetic and labelled. Briefs and research are in `claude-implementation-prompt.md`, `reference-research.md`, `prompt-review-notes.md`.

## Product Principles

1. Access first: authorization is enforced before anything is aggregated or shown; tenancy and role checks sit in the query, not the view.
2. Evidence over guesses: every status shows its source, freshness and certainty; unknown stays unknown. Sync state (Pending, Syncing, Synced, Offline, Conflict, Access revoked) is always visible and always text plus icon.
3. Review waiting is its own dimension; labels route attention but never grant authority.
4. Never fabricate: no fake live data, no silently successful writes, no invented trends.
5. Explicit, confirmed, reversible actions for anything that touches GitHub; never overwrite someone's same-record edit silently.
6. Motion explains change and never delays work: nothing animates on keystrokes, filters or background refresh. A value changes with motion only when the change answers something the person just did (a press, a tap, a key within the last three seconds); the same change arriving through a refresh timer, live update or another tab is swapped in silently. `Metric` implements this.

## Accessibility & Inclusion

Keyboard-only operation, visible focus, non-drag alternatives, real reduced-motion alternatives, status never conveyed by color alone, contrast checked in **both** light and dark themes, works at 390/768/1280/1536 px and 200% zoom. **[assumed]** WCAG 2.2 AA target.
