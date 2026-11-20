import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { bindRunner, boundToken, forgetCredential, type Binding } from "@/lib/github/bound";
import { IdentityError, type GhRunner } from "@/lib/github/exec";
import { directFetch, getGhRunner, defaultGhRunner, ghFetch } from "@/lib/github/gh";

/**
 * The only way application code reaches GitHub: a runner bound to THIS profile's account (its immutable numeric id),
 * read from the profile database. Sync, immediate writes, queued retries, repository creation, invitations and conflict
 * resolution all go through it, so none of them can run as whichever account the CLI happens to have selected.
 */
const bound = new WeakMap<Db, Map<string, GhRunner>>();

async function bindingOf(db: Db): Promise<Binding> {
  const user = await db.user.findFirst({ where: { isDemo: false, githubId: { not: null } }, orderBy: { createdAt: "asc" } });
  if (!user) throw new IdentityError("not-signed-in", "This profile has no GitHub account yet. Sign in first.");
  return { id: user.githubId as bigint, login: user.login, host: env().MERGEPORT_HOST };
}

export function profileRunner(db: Db): GhRunner {
  return async (args, opts) => {
    const b = await bindingOf(db);
    const key = `${b.host}#${b.id}#${b.login}`;
    let perDb = bound.get(db);
    if (!perDb) bound.set(db, (perDb = new Map()));
    let r = perDb.get(key);
    if (!r) perDb.set(key, (r = bindRunner(b)));
    return r(args, opts);
  };
}

/**
 * The `fetch` for GitHub traffic. By default requests go straight to the API with the profile's verified token, which is about twice as
 * fast as starting `gh` for each one (the token is still obtained from `gh` once and checked against the profile's account id).
 * Set MERGEPORT_GH_TRANSPORT=cli to send everything through `gh api` instead, as before. A substituted runner (tests) always uses `gh api`.
 */
export function profileFetch(db: Db, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): typeof fetch {
  const viaCli = process.env.MERGEPORT_GH_TRANSPORT === "cli" || getGhRunner() !== defaultGhRunner;
  if (viaCli) return ghFetch(profileRunner(db), undefined, opts);
  let binding: Binding | null = null;
  return directFetch(
    async () => {
      binding = await bindingOf(db);
      return boundToken(binding);
    },
    undefined,
    { ...opts, onUnauthorized: () => binding && forgetCredential(binding) },
  );
}
