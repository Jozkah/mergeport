import type { UpstreamUpdateRun } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { repoWhere, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { CommandError, NEEDS_PERSON, RELEASE_ATTENTION_DAYS, cleanSettings, safeReleaseUrl, type CommitInfo, type PromoteMode, type ReleaseInfo, type UpdateMode, type UpdateState } from "@/lib/domain/upstream-update";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { UPDATE_JOB, updateJobKey } from "@/lib/local/upstream-updater-job";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { audit } from "./audit";
import { maybeRequestReleaseCheck } from "./upstream-releases";

/**
 * Settings, history and the "Run now" request of the upstream auto-updater. The verify command is stored ONLY here (the local
 * database): it is never put in a space, a hub message or a backup, and it runs on this computer, so only an administrator of this
 * profile can set it.
 */

async function mappingFor(db: Db, v: Viewer, mappingId: string) {
  const m = await db.forkMapping.findFirst({ where: { id: mappingId, fork: repoWhere(v), upstream: repoWhere(v) }, include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } } } });
  if (!m) throw new NotFoundError();
  return m;
}

export type UpdateConfigView = {
  enabled: boolean;
  mode: UpdateMode;
  verifyCommand: string;
  promote: PromoteMode;
  timeoutSec: number;
  branchName: string;
  lastRunAt: Date | null;
  includePrereleases: boolean;
  /** Release watch: when the list was last read, and the release it stands on (the baseline or the last warning). */
  releasesCheckedAt: Date | null;
  lastReleaseTag: string | null;
  releasesBaselined: boolean;
};
export const DEFAULT_VIEW: UpdateConfigView = { enabled: false, mode: "merge", verifyCommand: "", promote: "pr", timeoutSec: 1200, branchName: "mergeport/upstream-sync", lastRunAt: null, includePrereleases: false, releasesCheckedAt: null, lastReleaseTag: null, releasesBaselined: false };

/** Only an administrator sees (and so can edit) the command; anyone else gets the defaults shape without it. */
export async function getUpdateConfig(db: Db, v: Viewer, mappingId: string): Promise<UpdateConfigView> {
  await mappingFor(db, v, mappingId);
  const c = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!c) return DEFAULT_VIEW;
  return {
    enabled: c.enabled,
    mode: c.mode === "releases" ? "releases" : "merge",
    verifyCommand: v.isAdmin ? (c.verifyCommand ?? "") : "",
    promote: c.promote === "push" ? "push" : "pr",
    timeoutSec: c.timeoutSec,
    branchName: c.branchName,
    lastRunAt: c.lastRunAt,
    includePrereleases: c.includePrereleases,
    releasesCheckedAt: c.releasesCheckedAt,
    lastReleaseTag: c.lastReleaseTag,
    releasesBaselined: c.releasesBaselined,
  };
}

export async function saveUpdateConfig(db: Db, v: Viewer, mappingId: string, raw: { mode?: unknown; enabled?: unknown; verifyCommand?: unknown; promote?: unknown; timeoutSec?: unknown; branchName?: unknown; includePrereleases?: unknown }) {
  const m = await mappingFor(db, v, mappingId);
  if (!v.isAdmin) throw new ForbiddenError("Only an administrator can change auto-update: its verify command runs on this computer");
  await requireRepo(db, v, m.forkRepoId, "manageWork");
  let c;
  try {
    c = cleanSettings(raw, m);
  } catch (e) {
    if (e instanceof CommandError) throw new ValidationError(e.message);
    throw e;
  }
  const prev = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  const incl = c.includePrereleases ?? prev?.includePrereleases ?? false;
  // `releases` mode writes none of the merge settings: what was stored (verify command, promote mode, ...) stays for when the person switches back.
  const data: Record<string, unknown> =
    c.mode === "merge"
      ? { enabled: c.enabled, mode: "merge", verifyCommand: c.verifyCommand, promote: c.promote, timeoutSec: c.timeoutSec, branchName: c.branchName }
      : { enabled: c.enabled, mode: "releases" };
  if (c.includePrereleases !== null) data.includePrereleases = c.includePrereleases;
  // Starting to watch (or changing which releases count) starts from where things stand now: the first check is a baseline, not a flood.
  const watching = c.enabled && c.mode === "releases";
  const rebaseline = watching && !(prev?.enabled && prev.mode === "releases" && incl === prev.includePrereleases);
  if (rebaseline) Object.assign(data, { releasesBaselined: false, lastReleaseId: null, lastReleaseTag: null, lastReleaseAt: null, releasesEtag: null, releasesCheckedAt: null });
  await db.upstreamUpdateConfig.upsert({ where: { mappingId }, create: { mappingId, ...data }, update: data });
  if (rebaseline) await maybeRequestReleaseCheck(db, mappingId); // record the baseline now, not at the next 15-minute cycle
  // The command itself is deliberately not written to the audit log.
  await audit(db, v, "upstream.update-config", { type: "ForkMapping", id: mappingId }, c.mode === "merge" ? { enabled: c.enabled, mode: c.mode, promote: c.promote, hasVerify: !!c.verifyCommand } : { enabled: c.enabled, mode: c.mode, includePrereleases: incl });
  return c;
}

export type UpdateRunView = {
  id: string;
  state: UpdateState;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  upstreamSha: string | null;
  forkSha: string | null;
  tried: string[];
  prUrl: string | null;
  files: string[];
  commits: CommitInfo[];
  logTail: string;
  error: string | null;
  /** release-found only. `url` is only kept when it points into the upstream repository. */
  release: ReleaseInfo | null;
  seenAt: Date | null;
};

export async function listUpdateRuns(db: Db, v: Viewer, mappingId: string, limit = 10): Promise<UpdateRunView[]> {
  const m = await mappingFor(db, v, mappingId);
  const rows = await db.upstreamUpdateRun.findMany({ where: { mappingId }, orderBy: { startedAt: "desc" }, take: limit });
  return rows.map((r) => toView(r, m.upstream.fullName));
}

function toView(r: UpstreamUpdateRun, upstreamFullName: string): UpdateRunView {
  return {
    id: r.id,
    state: r.state as UpdateState,
    trigger: r.trigger,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    upstreamSha: r.upstreamSha,
    forkSha: r.forkSha,
    tried: Array.isArray(r.triedShas) ? (r.triedShas as string[]) : [],
    prUrl: r.prUrl,
    files: Array.isArray(r.filesConflicted) ? (r.filesConflicted as string[]) : [],
    commits: Array.isArray(r.commits) ? (r.commits as CommitInfo[]) : [],
    logTail: r.logTail,
    error: r.error,
    release: toRelease(r.release, upstreamFullName),
    seenAt: r.seenAt,
  };
}

/** What the database holds is data, not trusted markup: only known fields, only text, and a link only into the upstream repository. */
function toRelease(raw: unknown, upstreamFullName: string): ReleaseInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  if (text(x.id) === null || text(x.tag) === null) return null;
  return {
    id: x.id as string,
    tag: x.tag as string,
    name: text(x.name),
    url: safeReleaseUrl(text(x.url), upstreamFullName, env().MERGEPORT_HOST),
    publishedAt: text(x.publishedAt),
    prerelease: x.prerelease === true,
    notes: text(x.notes) ?? "",
    inFork: typeof x.inFork === "boolean" ? x.inFork : null,
    more: typeof x.more === "number" ? x.more : 0,
  };
}

/** "Run now": queues the job. The run itself happens in the background and shows up in the history. */
export async function requestUpdateRun(db: Db, v: Viewer, mappingId: string) {
  const m = await mappingFor(db, v, mappingId);
  await requireRepo(db, v, m.forkRepoId, "manageWork");
  const c = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!c?.enabled) throw new ValidationError("Turn on auto-update for this fork first");
  if (c.mode === "releases") await maybeRequestReleaseCheck(db, mappingId, { manual: true }); // one check now: no clone, no run
  else await enqueue(db, { type: UPDATE_JOB, payload: { mappingId, manual: true }, dedupeKey: updateJobKey(mappingId), maxAttempts: 2 });
  await audit(db, v, "upstream.update-run", { type: "ForkMapping", id: mappingId });
}

export type AttentionRun = UpdateRunView & { mappingId: string; fork: string; upstream: string };

/** The person has looked at the release warnings of this mapping (the Forks page was opened). Only an administrator, who is who they are shown to. */
export async function markReleasesSeen(db: Db, v: Viewer, mappingId: string): Promise<number> {
  await mappingFor(db, v, mappingId);
  if (!v.isAdmin) return 0;
  return (await db.upstreamUpdateRun.updateMany({ where: { mappingId, state: "release-found", seenAt: null }, data: { seenAt: new Date() } })).count;
}

/**
 * Runs that need the person, for the daily digest: the LATEST settled run of each mapping the viewer can see, when it ended after
 * `since` as a conflict, a failed verification, a failure, or a pull request waiting for review. A newer run that went through (or an
 * up-to-date answer) replaces an older problem, so nothing stale is reported.
 *
 * Release warnings are separate (a newer merge run does not answer them): every `release-found` run the person has not looked at yet
 * (`seenAt`, set when the Forks page is opened), from the last RELEASE_ATTENTION_DAYS days (`releaseSince` overrides the cutoff).
 */
export async function upstreamUpdateAttention(db: Db, v: Viewer, o: { since: Date; releaseSince?: Date }): Promise<AttentionRun[]> {
  const maps = await db.forkMapping.findMany({ where: { fork: repoWhere(v), upstream: repoWhere(v), updateRuns: { some: { finishedAt: { not: null } } } }, include: { fork: true, upstream: true } });
  const out: AttentionRun[] = [];
  const releaseSince = o.releaseSince ?? new Date(Date.now() - RELEASE_ATTENTION_DAYS * 86_400_000);
  for (const m of maps) {
    const ids = { mappingId: m.id, fork: m.fork.fullName, upstream: m.upstream.fullName };
    const last = await db.upstreamUpdateRun.findFirst({ where: { mappingId: m.id, finishedAt: { not: null }, state: { not: "release-found" } }, orderBy: [{ finishedAt: "desc" }, { startedAt: "desc" }] });
    if (last && (NEEDS_PERSON as readonly string[]).includes(last.state) && last.finishedAt! >= o.since) out.push({ ...toView(last, m.upstream.fullName), ...ids });
    const releases = await db.upstreamUpdateRun.findMany({ where: { mappingId: m.id, state: "release-found", seenAt: null, finishedAt: { gte: releaseSince } } });
    for (const r of releases) {
      const view = toView(r, m.upstream.fullName);
      if (view.release) out.push({ ...view, ...ids });
    }
  }
  return out.sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
}
