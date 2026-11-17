---
name: mergeport
description: Create, assign, label, move, complete or list tasks in the user's local Mergeport (GitHub control center) board. Use when the user says things like "add this to mergeport", "create/put/track/log a task in mergeport", "mergeport todo", "mergeport: ...", "under <repo> repo", "assign <person>", "put this on my mergeport board", "add to the <project> board", "label it bug", "move it to In progress", "mark it done", or "what are my open mergeport tasks".
---

# Mergeport tasks

Mergeport keeps planning tasks (title, assignee, priority, due date, labels, board column) in a local database. This skill writes them through a command line tool in the Mergeport checkout. A task here is a Mergeport record only. Never create GitHub issues or pull requests, and never call GitHub, for these requests.

## Find the tool

1. Use the directory in the `MERGEPORT_DIR` environment variable if it is set.
2. Otherwise use `C:\Users\Jozkah\Desktop\Coding\Mergeport`.
3. If neither has a `package.json` named `mergeport`, ask the user where Mergeport is checked out.

Run every command from that directory as `npm run mp -- <command> ...`. Add `--json` and read stdout as JSON. Errors go to stderr with a nonzero exit code. The app may be running while you do this.

## Procedure for a new task

1. If the title, the repository (or project) or the assignee is unclear, ask ONE short question. Do not ask about optional fields (priority, due date, labels).
2. Run `npm run mp -- projects --json`. Match the user's repo words against `repos` and `name`. Never invent a repo or a person.
3. Run `npm run mp -- task add --title "<title>" --repo <repo> [more flags] --dry-run --json`.
4. Show the user the one-line preview. If the user's words already asked for it (add, create, put, track, log, assign), run the same command again without `--dry-run` straight away. Ask first only if they were only brainstorming.
5. Report the task id and the link path (`/tasks/<id>`, opened in the Mergeport app).

## Field mapping

| User says | Flag |
| --- | --- |
| a repo, "under X repo" | `--repo X` (name or `owner/name`) |
| a project or board name | `--project "<name>"` |
| a person, "give it to z", "@z" | `--assign z` (login; "me" means the user) |
| "urgent", "asap", "high priority" | `--priority urgent` or `high` (also none, low, medium) |
| "by friday", "tomorrow", a date | `--due fri`, `--due tomorrow`, `--due 2026-12-01` |
| "bug", "frontend" | `--label bug` (repeat the flag for more) |
| "in progress", "backlog", "ready" | `--column in-progress` |
| extra detail from the user | `--description "<text>"` |

Pass titles and descriptions as plain quoted data. Do not add words the user did not say.

## Other commands

- Change a task: `npm run mp -- task update <id> --assign z --priority high --due fri --label bug --unlabel old --column in-progress --title "<t>"`
- Finish a task: `npm run mp -- task done <id>`
- List: `npm run mp -- task list --mine --open --json` (also `--assignee z`, `--repo X`, `--project P`, `--limit n`)

## Errors and ambiguity

- If the tool reports several repositories, projects or people (it prints a candidates list), show the candidates to the user and ask which one. Never pick for them.
- If a repository is in several projects, ask which project and rerun with `--project`.
- If an assignee is not known to the project, tell the user. Use `--any-login` only when they confirm that exact login.
- If the tool says no profile was found, tell the user to start Mergeport once (`npm run local`). Do not search for or open database files yourself.
- Do not read or print tokens or secrets. Do not edit the database directly.

## Examples

1. "Add this to mergeport under atlas-api repo, assign bram" -> `task add --title "<this>" --repo atlas-api --assign bram`
2. "Create a mergeport task for rotating keys in repo atlas-web for @carol due friday, high priority" -> `--title "Rotate keys" --repo atlas-web --assign carol --due fri --priority high`
3. "Put this on my mergeport board" (one project exists) -> `--project "<that project>"`; if several exist, ask which.
4. "Mergeport: todo fix the login redirect, label it bug" -> `--title "Fix the login redirect" --label bug` plus the repo or project you resolved.
5. "Track this in mergeport and give it to z" -> `--assign z`
6. "Add to the Atlas board: write release notes, urgent" -> `--project Atlas --title "Write release notes" --priority urgent`
7. "Move it to In progress" (a task id is known) -> `task update <id> --column in-progress`
8. "What are my open mergeport tasks?" -> `task list --mine --open --json`, then summarize id, title, project, due.
