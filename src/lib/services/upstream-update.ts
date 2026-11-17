import type { UpstreamUpdateRun } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { repoWhere, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { CommandError, NEEDS_PERSON, cleanConfig, type CommitInfo, type PromoteMode, type UpdateState } from "@/lib/domain/upstream-update";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { UPDATE_JOB, updateJobKey } from "@/lib/local/upstream-updater-job";
import { enqueue } from "@/lib/jobs";
import { audit } from "./audit";

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

export type UpdateConfigView = { enabled: boolean; verifyCommand: string; promote: PromoteMode; timeoutSec: number; branchName: string; lastRunAt: Date | null };
export const DEFAULT_VIEW: UpdateConfigView = { enabled: false, verifyCommand: "", promote: "pr", timeoutSec: 1200, branchName: "mergeport/upstream-sync", lastRunAt: null };

/** Only an administrator sees (and so can edit) the command; anyone else gets the defaults shape without it. */
export async function getUpdateConfig(db: Db, v: Viewer, mappingId: string): Promise<UpdateConfigView> {
  await mappingFor(db, v, mappingId);
  const c = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!c) return DEFAULT_VIEW;
  return { enabled: c.enabled, verifyCommand: v.isAdmin ? (c.verifyCommand ?? "") : "", promote: c.promote === "push" ? "push" : "pr", timeoutSec: c.timeoutSec, branchName: c.branchName, lastRunAt: c.lastRunAt };
}

export async function saveUpdateConfig(db: Db, v: Viewer, mappingId: string, raw: { enabled?: unknown; verifyCommand?: unknown; promote?: unknown; timeoutSec?: unknown; branchName?: unknown }) {
  const m = await mappingFor(db, v, mappingId);
  if (!v.isAdmin) throw new ForbiddenError("Only an administrator can change auto-update: its verify command runs on this computer");
  await requireRepo(db, v, m.forkRepoId, "manageWork");
  let c;
  try {
    c = cleanConfig(raw, m);
  } catch (e) {
    if (e instanceof CommandError) throw new ValidationError(e.message);
    throw e;
  }
  const data = { enabled: c.enabled, verifyCommand: c.verifyCommand, promote: c.promote, timeoutSec: c.timeoutSec, branchName: c.branchName };
  await db.upstreamUpdateConfig.upsert({ where: { mappingId }, create: { mappingId, ...data }, update: data });
  // The command itself is deliberately not written to the audit log.
  await audit(db, v, "upstream.update-config", { type: "ForkMapping", id: mappingId }, { enabled: c.enabled, promote: c.promote, hasVerify: !!c.verifyCommand });
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
};

export async function listUpdateRuns(db: Db, v: Viewer, mappingId: string, limit = 10): Promise<UpdateRunView[]> {
  await mappingFor(db, v, mappingId);
  const rows = await db.upstreamUpdateRun.findMany({ where: { mappingId }, orderBy: { startedAt: "desc" }, take: limit });
  return rows.map(toView);
}

function toView(r: UpstreamUpdateRun): UpdateRunView {
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
  };
}

/** "Run now": queues the job. The run itself happens in the background and shows up in the history. */
export async function requestUpdateRun(db: Db, v: Viewer, mappingId: string) {
  const m = await mappingFor(db, v, mappingId);
  await requireRepo(db, v, m.forkRepoId, "manageWork");
  const c = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!c?.enabled) throw new ValidationError("Turn on auto-update for this fork first");
  await enqueue(db, { type: UPDATE_JOB, payload: { mappingId, manual: true }, dedupeKey: updateJobKey(mappingId), maxAttempts: 2 });
  await audit(db, v, "upstream.update-run", { type: "ForkMapping", id: mappingId });
}

export type AttentionRun = UpdateRunView & { mappingId: string; fork: string; upstream: string };

/**
 * Runs that need the person, for the daily digest (not wired into it here): the LATEST settled run of each mapping the viewer can
 * see, when it ended after `since` as a conflict, a failed verification, a failure, or a pull request waiting for review. A newer
 * run that went through (or an up-to-date answer) replaces an older problem, so nothing stale is reported.
 */
export async function upstreamUpdateAttention(db: Db, v: Viewer, o: { since: Date }): Promise<AttentionRun[]> {
  const maps = await db.forkMapping.findMany({ where: { fork: repoWhere(v), upstream: repoWhere(v), updateRuns: { some: { finishedAt: { not: null } } } }, include: { fork: true, upstream: true } });
  const out: AttentionRun[] = [];
  for (const m of maps) {
    const last = (await db.upstreamUpdateRun.findFirst({ where: { mappingId: m.id, finishedAt: { not: null } }, orderBy: [{ finishedAt: "desc" }, { startedAt: "desc" }] }))!;
    if (!(NEEDS_PERSON as readonly string[]).includes(last.state) || last.finishedAt! < o.since) continue;
    out.push({ ...toView(last), mappingId: m.id, fork: m.fork.fullName, upstream: m.upstream.fullName });
  }
  return out.sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
}
