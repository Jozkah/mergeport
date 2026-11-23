# Live GitHub check runbook

Everything GitHub-side was built and tested against a fake GitHub server. This runbook is how to check the real thing, once, with a
throwaway account. The numbered items refer to "Needs a live check" in `docs/github-app.md`; record the real answer next to each and
fix the code or the doc where GitHub disagrees.

## 0. What you need

- A throwaway GitHub **organization** you own, plus your personal account. A second GitHub account (a friend or an alt) is needed for
  items marked **[2nd]**. Create two repositories in the org: `public-demo` (public) and `private-demo` (private), each with one issue and one pull request.
- A hosted Mergeport you can reach over **https** (a tunnel such as Cloudflare Tunnel or ngrok to a local `npm run build && npm start` is fine).
  Behind it: `MERGEPORT_PUBLIC_URL=<https url>`, `MERGEPORT_TRUST_PROXY=true`, a Postgres, `npm run worker` running, and
  `MERGEPORT_ENCRYPTION_KEY` set (32+ characters). Do not set `MERGEPORT_GITHUB_API_BASE`.
- Do the checks in a copy of the database you can throw away.

## 1. Register the App

Follow "Register the App" in `docs/github-app.md` exactly: the three callback URLs, the webhook URL and secret, the **Email addresses**
user permission, **Members (read)** organization permission, the repository read permissions and the event list. Install it **only on the
throwaway org**. Put the seven `MERGEPORT_GITHUB_APP_*` values in the environment and restart. Settings > GitHub should now offer Connect.

## 2. Checks, in order

| Step | Do this | Items |
| --- | --- | --- |
| A | Sign in by email link, create a workspace, Settings > GitHub > Connect, install on the org. Then try the same as a **non-owner** org member **[2nd]**, and connect a **personal** installation. | 1, 3, 4, 6, 7, 8, 9, 10 |
| B | In the App's "Advanced" tab check "Recent deliveries": the ping should be 200. Edit an issue and open a PR in `private-demo`; watch Settings > GitHub "Live updates". Redeliver one delivery from GitHub's page, then one that failed. Remove a repository from the installation. Delete a test repository. Put a body-rewriting proxy in front only if you want to test item 17 (skip otherwise). | 11-18 |
| C | Settings > Linked accounts > Link GitHub as a person who is **not** a collaborator on `private-demo` **[2nd]**, and as one who is. Check which repositories each person sees. Wait for the token to expire (8 hours) or revoke it at GitHub, and see the relink state. Unlink and confirm `DELETE /applications/<client_id>/token` ended the token. | 19-23 |
| D | Sign out. "Continue with GitHub" as (1) a linked person, (2) a brand-new GitHub account with a verified primary email **[2nd]**, (3) an account whose verified email already belongs to an existing Mergeport user **[2nd]** (must be refused), (4) an account with no installation anywhere. Repeat (2) in Safari and Firefox. | 24-27 |
| E | Set `MERGEPORT_GITHUB_WRITES=on`, restart. In the App settings raise Issues and Pull requests to **Read and write**; accept the new permissions as the org owner. Settings > GitHub > "Write to GitHub as you" on. Create an issue from a task and post a comment as a person with write access, then as a read-only collaborator **[2nd]**, then in an org with SAML SSO if you have one. Look at the posted text and footer on GitHub. Hammer the button to see rate-limit answers. | 28-33 |
| F | Turn the writes env off and restart; confirm the buttons disappear and writes are refused. | - |

## 3. How to record results

For each item write one line in `docs/github-app.md`: **confirmed**, or **different: <what GitHub really does>** and open an issue for
the code change. The items most likely to differ (check these first): 1 (organization owner check), 3 and 21 (PKCE on the App authorize URL),
20 (what the user's repository list shows), 24 (email endpoint with an App token), 28 and 29 (write permissions and what owners see).

## 4. Clean up

Revoke the user authorization of the App in your GitHub settings, delete the throwaway org and the App (or rotate its private key and
secrets), and drop the throwaway database.
