# Moving from the centralized (Postgres) version

Earlier versions of Mergeport ran as one shared server with PostgreSQL, a GitHub App and a worker. That is no longer the architecture: every person runs the app locally on SQLite and teams share state through private GitHub repositories. The old schema and migrations are kept under `prisma/legacy/` for reference.

## Nothing is deleted

Your Postgres database is never modified. The importer reads it and writes a **new** SQLite profile.

## Import

You need the connection string of the old database and your GitHub login.

```bash
# See what would be copied, writing nothing to your profile:
npm run migrate:from-postgres -- --from postgresql://user:pass@host:5432/mergeport --login your-github-login --dry-run

# Do it. The target is your profile for that account, which `npm run local` opens:
npm run migrate:from-postgres -- --from postgresql://user:pass@host:5432/mergeport --login your-github-login
```

The target must be empty. `--to <file>` writes somewhere else. The printed report lists, per table, rows imported and rows left behind.

## What is copied

Only rows you could already see in the old app:

- your user and membership (you become the sole administrator of your **local** data);
- the repositories you were granted (or all of them if you were an administrator), with their owners, branches, work items, comments, reviews and sync state;
- projects you belonged to, their boards, cards, dependencies, milestones, waiting records, review rules, saved filters and your notifications.

Search indexes SQLite needs (label and assignee lists) are rebuilt. Authorship by other people is attributed to you; their accounts are not imported.

## What is deliberately not copied

- **Credentials**: stored GitHub tokens, sessions, device token hashes. Sign in again with `gh`.
- **Machine paths and worktree snapshots**: map your folders again on **Branches & worktrees**.
- **Sharing**: imported repositories and projects are **local only**. To give teammates the same board, create a team and share a repository or project to a space (**Team**, **Repositories**, **Projects**). Nothing becomes visible to anyone by migrating.
- Queued jobs, webhook deliveries, invitations and repository proposals.

## Do not sync database files

Do not copy `mergeport.db` to a teammate or through Git, and do not share a `.env`. Each person has their own database. Teams share through the coordination repositories only.

## Upgrading a local database

Migrations apply automatically when the profile opens. A database created by a **newer** Mergeport is refused with a clear message instead of being guessed at. Shared files carry a schema version; files written by a newer version are read-only and never rewritten by an older one.
