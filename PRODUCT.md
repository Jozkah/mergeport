# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the written implementation briefs (no interview round; the briefs answer users, purpose and constraints in detail). Items marked **[assumed]** are not user-confirmed.

## Platform

web, served by a local process on the user's own computer (127.0.0.1)

## Stack

TypeScript, Next.js App Router on a local Node process, SQLite (one database per GitHub account, via Prisma and better-sqlite3), Tailwind CSS, Octokit over the official GitHub CLI (`gh api`), Lucide, dnd-kit, GSAP for the few layout animations CSS cannot express. No Docker, Postgres, VPS, tunnel, public webhook, GitHub App or shared secret.

## Users

- **Individual**: tracks repositories they can already reach, keeps boards and internal tasks locally, and sees what to review and what is waiting on someone else. Personal mode needs nothing but `gh`.
- **Team owner**: creates a team (a private GitHub repository for shared planning), invites collaborators, and may create restricted spaces (separate private repositories) for smaller audiences. Their administrative power comes from GitHub's permission on that repository.
- **Teammate**: accepts the GitHub invitation, signs in as themself, joins by link, and sees only the spaces their GitHub access allows.
- **External reviewer** (tracked, not a member): a GitHub user or team whose review other work waits on.

## Product Purpose

A local-first control center for selected GitHub repositories: attention queues (needs my review vs waiting on others), planning across repos, fork/upstream intelligence, and read-only local worktree visibility. A team's Mergeport-owned data syncs through private GitHub repositories instead of a server. Success: nobody opens GitHub tabs to answer "what do I review, what is blocked on whom, what upstream work is my fork missing", and nobody runs infrastructure to share a board.

## Positioning

GitHub stays the source of truth for issues, pull requests, reviews and labels, fetched with each person's own access. Mergeport owns only planning data, and shares it through repositories whose audience **is** the privacy boundary. Review-waiting is its own workflow dimension; fork/upstream status shows honest evidence levels instead of guesses.

## Operating Context

One person, one computer, one account profile; optional teams. Offline-tolerant: edits are saved locally first and sent when GitHub is reachable. Shared state is eventually consistent by polling (about 30 s while open, backing off to 10 min), stated plainly in the UI. Demo mode (synthetic data, no GitHub) is separate from connected mode.

## Capabilities and Constraints

- Access model: privacy is enforced by **which repository holds the data**, never by hiding rows locally. Admin operations map to GitHub permissions, not editable role strings.
- Credentials stay in the GitHub CLI; the browser, shared repositories, logs and exported configuration never hold a token. Nothing from a coordination repository is ever executed or installed.
- Server-side authorization on every resource; scoped counts and search; non-leaking not-found.
- No real GitHub mutations, repository creation or invitations to demonstrate features; live checks need an explicitly approved disposable target.
- Do not infer account types (e.g. `northwind`) by name; fixtures with that owner are synthetic.
- Out of scope: billing, chat, AI assistant, code editor, Projects v2 sync, worktree mutation, sharing worktree data, peer-to-peer sync, syncing database files.

## Evidence on Hand

No real data, customers or metrics. All demo data is synthetic and labelled. Briefs and research are in `claude-implementation-prompt.md`, `reference-research.md`, `prompt-review-notes.md`.

## Product Principles

1. Access first: authorization is enforced before anything is aggregated or shown; privacy lives in repository boundaries.
2. Evidence over guesses: every status shows its source, freshness and certainty; unknown stays unknown. Sync state (Pending, Syncing, Synced, Offline, Conflict, Access revoked) is always visible and always text plus icon.
3. Review waiting is its own dimension; labels route attention but never grant authority.
4. Never fabricate: no fake live data, no silently successful writes, no invented trends.
5. Explicit, confirmed, reversible actions for anything that touches GitHub; never overwrite someone's same-record edit silently.
6. Motion explains change and never delays work: nothing animates on keystrokes, filters or background refresh.

## Accessibility & Inclusion

Keyboard-only operation, visible focus, non-drag alternatives, real reduced-motion alternatives, status never conveyed by color alone, contrast checked in **both** light and dark themes, works at 390/768/1280/1536 px and 200% zoom. **[assumed]** WCAG 2.2 AA target.
