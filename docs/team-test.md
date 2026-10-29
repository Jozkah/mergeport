# Two-account team test (prepared, not run)

Nothing in this file has been executed. Every step that changes GitHub waits for explicit approval of the teammate, the destination and the actions listed under "Approval needed".

## Goal

Show, with two real accounts, that:

1. creating a team does exactly what the plan screen says, and nothing else;
2. a join link names a repository but never grants access: GitHub's own permission decides;
3. membership of the coordination repository grants **no** access to anyone's source repositories;
4. shared planning data syncs both ways, conflicts surface instead of being overwritten, and offline edits are sent later;
5. revoking access on GitHub stops the teammate's sync, and the app says so.

## Setup

- Person A: the owner account already used for the read-only checks (profile `github.com-<id>`).
- Person B: a second GitHub account (the teammate) with its **own** `gh` sign-in and its own Mergeport profile, on its own computer, or on this computer with an isolated environment (`GH_CONFIG_DIR` pointing to a new folder and `MERGEPORT_HOME` to another) so A's globally selected `gh` account is never switched. B performs B's own `gh auth login`; no credential is typed by anyone else.
- Both run `npm run local`. No server, tunnel or shared secret.

## Approval needed (all external writes)

| # | Action | Where | Reversible? |
| --- | --- | --- | --- |
| 1 | Create one **private** repository `A/mergeport-<team-slug>-workspace` through Team > Create a team (the app first shows owner, name, visibility and permissions; nothing is created until Confirm) | A's personal account | Delete on GitHub (needs the `delete_repo` scope, which the current sign-in does not have, so A deletes it by hand in Settings) |
| 2 | Commit the coordination files (manifest, team configuration, space records) to that repository | the new repository only | With the repository |
| 3 | Invite B as a collaborator with **write** on that one repository | the new repository only | Revoke the invitation or collaborator |
| 4 | Test state writes: create/edit a card and an internal task in the shared space from A, then from B, including a concurrent edit and an offline edit | the new repository only | With the repository |
| 5 | Access-revocation test: A removes B as a collaborator | the new repository only | Re-invite |

Not requested: any change to any source repository (no comment, review, label, merge or push), organization settings, tokens or scopes.

## Steps and expected results

1. **Plan only.** A: Team > Create a team > Review plan. Expect: owner A, name `mergeport-<slug>-workspace`, private, the permission sentences, and nothing created (GitHub unchanged). Cancel once to prove it.
2. **Create.** A confirms. Expect: exactly one new private repository; the Team page lists one space; the Sync page shows it synced.
3. **Join link without access.** A copies the join link and gives it to B *before* inviting. B: Team > Join > Review. Expect: refused with "Your GitHub account cannot read that repository", nothing downloaded or published. This is the check that a link is only a name.
4. **Invite.** A invites B (write, this repository only). B accepts on GitHub (B's own action, B's own sign-in).
5. **Join.** B pastes the link. Expect the review screen (what the repository is, what joining downloads and publishes); nothing happens until B confirms; afterwards B's Team page lists the space.
6. **Source access is separate.** B opens the board A shared that references A's private source repositories. Expect "Source repository access required" for items B cannot read on GitHub, no titles, no content; B's `gh` can still not read them. Confirm on GitHub that B has no access to A's source repositories.
7. **Two-way sync.** A creates a card; B sees it within the polling interval (about 17 s with the tab visible) with no reload. B edits another card; A sees it.
8. **Conflict.** Both go offline (or pause polling), edit the same field of the same card, then reconnect. Expect a conflict row on both with both versions, nothing discarded until someone chooses.
9. **Offline edit.** B edits with the network off (the top bar reads Offline and the edit is listed as pending), then reconnects. Expect exactly one commit for the edit, no duplicate.
10. **Revocation.** A removes B on GitHub. Expect on B within the next permission check: the space reads "Access revoked", cached shared data is removed, unsent edits are kept aside and listed on the Sync page, and no further request to the repository succeeds. Source repositories are unaffected.
11. **Clean up.** A deletes the disposable repository by hand (or archives it). B stops Mergeport and removes the isolated folders if any.

## Pass criteria

All eleven steps behave as stated, with GitHub's own audit and the repository history as evidence: one repository, commits only by the two accounts, no force pushes, no writes outside the coordination repository. Until then team collaboration stays **unverified**; the in-process simulation tests do not count.
