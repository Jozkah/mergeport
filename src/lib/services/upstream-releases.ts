import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { RELEASE_CHECK_MIN_MS, pickNewReleases, plainExcerpt, safeReleaseUrl, type ReleaseInfo } from "@/lib/domain/upstream-update";
import type { GithubPort } from "@/lib/github/port";
import { enqueue } from "@/lib/jobs";
import { notifyUpstream } from "./upstream-notify";

/**
 * The upstream auto-updater's "warn about releases only" mode. It asks GitHub for the upstream repository's releases and tells the
 * person about new ones. It never clones, fetches, merges, pushes, opens a pull request or runs a command: this module (and everything
 * it imports) has no git and no verify code in it, and nothing here writes to GitHub.
 */

export const RELEASES_JOB = "upstream.releases";
export const releasesJobKey = (mappingId: string) => `upstream-releases:${mappingId}`;

/**
 * Asks for a release check of one mapping (deduplicated, one job per mapping). Unless the person asked ("Run now"), at most one check per
 * mapping per ~15 minutes: a mapping checked recently is not asked again, whichever cycle (sync of the fork, regular reconcile) comes by.
 */
export async function maybeRequestReleaseCheck(db: Db, mappingId: string, o: { manual?: boolean; now?: Date } = {}): Promise<boolean> {
  const cfg = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!cfg?.enabled || cfg.mode !== "releases") return false;
  if (!o.manual && !releaseCheckDue(cfg.releasesCheckedAt, o.now ?? new Date())) return false;
  await enqueue(db, { type: RELEASES_JOB, payload: { mappingId, manual: o.manual === true }, dedupeKey: releasesJobKey(mappingId), maxAttempts: 2 });
  return true;
}

export const releaseCheckDue = (checkedAt: Date | null, now: Date) => !checkedAt || now.getTime() - checkedAt.getTime() >= RELEASE_CHECK_MIN_MS;

export type ReleaseCheck = { result: "skipped" | "not-modified" | "baseline" | "checked" | "failed"; warned: number };

/** One check of one mapping. `manual` skips the 15-minute cap and records a failure in the history instead of throwing. */
export async function runReleaseCheck(db: Db, port: GithubPort, mappingId: string, o: { manual?: boolean; now?: () => Date } = {}): Promise<ReleaseCheck> {
  const now = o.now ?? (() => new Date());
  const m = await db.forkMapping.findUnique({ where: { id: mappingId }, include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } }, updateConfig: true } });
  const cfg = m?.updateConfig;
  if (!m || !cfg?.enabled || cfg.mode !== "releases") return { result: "skipped", warned: 0 };
  if (!o.manual && !releaseCheckDue(cfg.releasesCheckedAt, now())) return { result: "skipped", warned: 0 };

  let list;
  try {
    list = await port.listReleases(m.upstream.owner.login, m.upstream.name, { etag: cfg.releasesEtag });
  } catch (e) {
    if (!o.manual) throw e; // the job retries it with backoff (a rate limit waits for its reset)
    const at = now();
    await db.upstreamUpdateRun.create({ data: { mappingId, state: "failed", trigger: "manual", startedAt: at, finishedAt: at, triedShas: [], commits: [], error: `Could not read the releases of ${m.upstream.fullName}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` } });
    return { result: "failed", warned: 0 };
  }
  const at = now();
  // An unchanged list (304) costs no rate limit and changes nothing but the time of the check.
  if (list.kind === "not-modified") {
    await db.upstreamUpdateConfig.update({ where: { mappingId }, data: { releasesCheckedAt: at } });
    return { result: "not-modified", warned: 0 };
  }

  const warned = new Set((await db.upstreamUpdateRun.findMany({ where: { mappingId, releaseId: { in: list.releases.map((r) => r.id) } }, select: { releaseId: true } })).map((r) => r.releaseId!));
  const { fresh, more, newest } = pickNewReleases(list.releases, { after: cfg.releasesBaselined ? cfg.lastReleaseAt : null, warned, includePrereleases: cfg.includePrereleases });
  const cursor = newest ? { lastReleaseId: newest.id, lastReleaseTag: newest.tag, lastReleaseAt: newest.publishedAt } : {};

  // The first check only remembers where things stand: enabling the mode must not announce the whole history.
  if (!cfg.releasesBaselined) {
    await db.upstreamUpdateConfig.update({ where: { mappingId }, data: { releasesBaselined: true, ...cursor, releasesEtag: list.etag, releasesCheckedAt: at } });
    return { result: "baseline", warned: 0 };
  }

  const host = env().MERGEPORT_HOST;
  for (const [i, r] of fresh.entries()) {
    const info: ReleaseInfo = {
      id: r.id,
      tag: r.tag,
      name: r.name ? plainExcerpt(r.name, 200) : null,
      url: safeReleaseUrl(r.htmlUrl, m.upstream.fullName, host),
      publishedAt: r.publishedAt!.toISOString(),
      prerelease: r.prerelease,
      notes: plainExcerpt(r.body),
      inFork: await forkHasTag(port, m, r.tag),
      more: i === fresh.length - 1 ? more : 0,
    };
    await db.upstreamUpdateRun.create({ data: { mappingId, state: "release-found", trigger: o.manual ? "manual" : "auto", startedAt: at, finishedAt: at, triedShas: [], commits: [], releaseId: r.id, release: info as never } });
    const title = `New upstream release ${plainExcerpt(r.tag, 80)}: ${m.upstream.fullName}${info.more ? ` (+${info.more} more)` : ""}`;
    await notifyUpstream(db, { kind: "upstream-release", mappingId, forkRepoId: m.forkRepoId, workspaceId: m.fork.workspaceId, title });
  }
  await db.upstreamUpdateConfig.update({ where: { mappingId }, data: { ...cursor, releasesEtag: list.etag, releasesCheckedAt: at } });
  return { result: "checked", warned: fresh.length };
}

/** One API call: is the release's tag an ancestor of the fork's branch? Anything but a clear answer is `null` (nothing is guessed). */
async function forkHasTag(port: GithubPort, m: { upstream: { name: string; owner: { login: string } }; fork: { owner: { login: string } }; forkBranch: string }, tag: string): Promise<boolean | null> {
  if (!tag) return null;
  try {
    const r = await port.isAncestor({ owner: m.upstream.owner.login, repo: m.upstream.name }, tag, `${m.fork.owner.login}:${m.forkBranch}`);
    return r === "ancestor" ? true : r === "not-ancestor" ? false : null;
  } catch {
    return null;
  }
}
