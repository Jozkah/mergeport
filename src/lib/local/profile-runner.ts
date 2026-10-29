import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { bindRunner } from "@/lib/github/bound";
import { IdentityError, type GhRunner } from "@/lib/github/exec";

/**
 * The only way application code reaches GitHub: a runner bound to THIS profile's account (its immutable numeric id),
 * read from the profile database. Sync, immediate writes, queued retries, repository creation, invitations and conflict
 * resolution all go through it, so none of them can run as whichever account the CLI happens to have selected.
 */
const bound = new WeakMap<Db, Map<string, GhRunner>>();

export function profileRunner(db: Db): GhRunner {
  return async (args, opts) => {
    const user = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
    if (!user) throw new IdentityError("not-signed-in", "This profile has no GitHub account yet. Sign in first.");
    const host = env().MERGEPORT_HOST;
    const key = `${host}#${user.githubId}#${user.login}`;
    let perDb = bound.get(db);
    if (!perDb) bound.set(db, (perDb = new Map()));
    let r = perDb.get(key);
    if (!r) perDb.set(key, (r = bindRunner({ id: user.githubId, login: user.login, host })));
    return r(args, opts);
  };
}
