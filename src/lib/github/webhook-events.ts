import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { enqueue, type EnqueueInput } from "@/lib/jobs";
import { repositoryIds, trackedRepositoriesAmong } from "./webhook-lifecycle";

/**
 * What a verified GitHub App delivery does here (docs/github-app.md, "Webhooks"). Called by the route AFTER the signature was checked.
 *
 * Ids in a payload only FIND our own rows: the installation id must already be a `GithubInstallation` we hold (a webhook never creates a
 * binding or an installation), and a repository id only matches repositories whose `installationId` is that same installation, in each
 * workspace bound to it. A validly signed payload that names another installation's repositories therefore matches nothing.
 *
 * Handlers only queue jobs (the existing `sync.item` / `sync.repository` jobs with their dedupe keys, and `github.installation.check` for
 * lifecycle events); GitHub is never called here, so the answer is fast. Order of work:
 *   1. the delivery id is recorded (`ON CONFLICT DO NOTHING`; zero rows = duplicate, nothing else happens);
 *   2. the jobs are queued OUTSIDE any transaction (`enqueue` resolves its create races by retrying, which a Postgres transaction that
 *      already saw a unique violation cannot do);
 *   3. if queueing fails, the delivery row is deleted again so GitHub's redelivery of the same id is processed, and the error is rethrown;
 *   4. only then the "live" stamps are set (`GithubInstallation.lastWebhookAt`, `Repository.lastEventAt`), at most once a minute per row.
 */

export type DeliveryResult =
  | { kind: "ignored" } //                 an event or action this deployment does not act on: no writes
  | { kind: "bad-payload" } //             a handled event without a usable installation id
  | { kind: "unknown-installation" } //    not an installation we hold: no writes
  | { kind: "duplicate" } //               this delivery id was already handled: no writes
  | { kind: "shed" } //                    this installation is sending far more than any real one: acknowledged, not queued
  | { kind: "accepted"; jobs: number };

/** Events that map to a refresh of one pull request or issue, with where its number sits in the payload. */
const ITEM_NUMBER: Record<string, (p: Obj) => number[]> = {
  issues: (p) => [num(obj(p.issue)?.number)],
  issue_comment: (p) => [num(obj(p.issue)?.number)],
  pull_request: (p) => [num(obj(p.pull_request)?.number)],
  pull_request_review: (p) => [num(obj(p.pull_request)?.number)],
  pull_request_review_comment: (p) => [num(obj(p.pull_request)?.number)],
  pull_request_review_thread: (p) => [num(obj(p.pull_request)?.number)],
  check_run: (p) => pullNumbers(obj(p.check_run)?.pull_requests),
  check_suite: (p) => pullNumbers(obj(p.check_suite)?.pull_requests),
};
/** Events that only say "something in this repository changed": the repository is refreshed. */
const REPOSITORY_EVENTS = new Set(["status", "push", "create", "delete", "label", "milestone"]);
/** `repository` actions that change what we show or whether we can still read it (a deleted one 404s in the job, which marks it DISCONNECTED as reconcile does). */
const REPOSITORY_ACTIONS = new Set(["publicized", "privatized", "renamed", "transferred", "edited", "deleted", "archived", "unarchived"]);
const LIFECYCLE_EVENTS = new Set(["installation", "installation_repositories"]);

export const HANDLED_EVENTS = new Set([...Object.keys(ITEM_NUMBER), ...REPOSITORY_EVENTS, "repository", ...LIFECYCLE_EVENTS]);

/** Far above any real installation (GitHub itself sends a few events a second at most): beyond it work is shed, not queued. */
export const INSTALLATION_EVENTS_PER_MINUTE = 3000;
export const STAMP_EVERY_MS = 60_000;

type Touched = { workspaceId: string; id: string };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
const id = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null);
/** At most 10 distinct pull request numbers of a check's `pull_requests` list. */
const pullNumbers = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.slice(0, 25).map((x) => num(obj(x)?.number)).filter((n) => n > 0))].slice(0, 10) : []);

/** What a delivery would do, decided from the event name and payload alone (no database): used to answer 202 for the irrelevant. */
export function isRelevant(event: string, payload: Obj): boolean {
  if (!HANDLED_EVENTS.has(event)) return false;
  if (event === "repository") return REPOSITORY_ACTIONS.has(typeof payload.action === "string" ? payload.action : "");
  return true;
}

export async function processDelivery(db: Db, input: { deliveryId: string; event: string; payload: Obj; now?: Date }): Promise<DeliveryResult> {
  const { deliveryId, event, payload } = input;
  const now = input.now ?? new Date();
  if (!isRelevant(event, payload)) return { kind: "ignored" };
  const installationId = id(obj(payload.installation)?.id);
  if (installationId === null) return { kind: "bad-payload" };

  const installation = await db.githubInstallation.findUnique({ where: { installationId }, select: { installationId: true } });
  if (!installation) return { kind: "unknown-installation" };
  // Per installation, never per address: a noisy installation must not starve a quiet one. Beyond the cap the delivery is acknowledged
  // without queueing (and without a stamp); the reconcile safety net covers what was shed, and dedupe keys already coalesce bursts.
  if (!(await take(db, `ghwh:inst:${installationId}`, INSTALLATION_EVENTS_PER_MINUTE, 60_000, now))) {
    console.error(`[github webhook] shed: installation ${installationId} is over ${INSTALLATION_EVENTS_PER_MINUTE} events a minute`);
    return { kind: "shed" };
  }
  // ON CONFLICT DO NOTHING: a repeated id is a no-op.
  const fresh = await db.githubDelivery.createMany({ data: [{ deliveryId, installationId, event, receivedAt: now }], skipDuplicates: true });
  if (fresh.count === 0) return { kind: "duplicate" };

  let queued: EnqueueInput[] = [];
  let repositoryRows: Touched[] = [];
  const stamp = !LIFECYCLE_EVENTS.has(event);
  try {
    const plan = await planJobs(db, installationId, event, payload);
    queued = plan.jobs;
    repositoryRows = plan.touched;
    for (const j of queued) await enqueue(db, j);
  } catch (e) {
    // Nothing is half-recorded: a redelivery of this id must be processed again (jobs that did get queued are coalesced by their keys).
    await db.githubDelivery.deleteMany({ where: { deliveryId } }).catch(() => {});
    throw e;
  }
  if (stamp) await stampLive(db, installationId, repositoryRows, now).catch(() => {}); // a stamp is a status line, never a reason to fail a delivery
  return { kind: "accepted", jobs: queued.length };
}

const check = (installationId: bigint): EnqueueInput => ({ type: "github.installation.check", payload: { installationId: String(installationId) }, dedupeKey: `ghinst:${installationId}`, workspaceId: null });
const repoJob = (workspaceId: string, repositoryId: string): EnqueueInput => ({ type: "sync.repository", payload: { repositoryId }, dedupeKey: `sync:${repositoryId}`, workspaceId });
const itemJob = (workspaceId: string, repositoryId: string, n: number): EnqueueInput => ({ type: "sync.item", payload: { repositoryId, number: n }, dedupeKey: `item:${repositoryId}:${n}`, workspaceId });

/** The jobs a delivery needs and the repository rows it touched (for the live stamps). Reads only; nothing is written here. */
async function planJobs(db: Db, installationId: bigint, event: string, payload: Obj): Promise<{ jobs: EnqueueInput[]; touched: Touched[] }> {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (event === "installation") return { jobs: [check(installationId)], touched: [] };
  if (event === "installation_repositories") {
    // Ask GitHub what is true now (the action word could be stale), and refresh each repository named as removed: its own request answers
    // 404 when GitHub really no longer shows it to this installation, which marks it DISCONNECTED (docs/github-app.md).
    const jobs = [check(installationId)];
    if (action === "removed") {
      const { ids, truncated } = repositoryIds(payload.repositories_removed);
      for (const r of await trackedRepositoriesAmong(db, installationId, ids)) jobs.push(repoJob(r.workspaceId, r.repositoryId));
      // Beyond the cap the rest waits for the regular reconcile: pull it forward instead of leaving it a full interval away.
      if (truncated) jobs.push({ type: "reconcile.all", payload: {}, dedupeKey: "reconcile", workspaceId: null });
    }
    return { jobs, touched: [] };
  }

  const repositoryGithubId = id(obj(payload.repository)?.id);
  if (repositoryGithubId === null) return { jobs: [], touched: [] };
  const numbers = (ITEM_NUMBER[event]?.(payload) ?? []).filter((n) => n > 0);
  const jobs: EnqueueInput[] = [];
  const touched: Touched[] = [];
  const bindings = await db.workspaceInstallation.findMany({ where: { installationId }, select: { workspaceId: true }, orderBy: { workspaceId: "asc" } });
  for (const b of bindings) {
    // The repository rows of THIS workspace that this installation serves. Another installation's, or an untracked one, matches nothing.
    const repos = await db.repository.findMany({
      where: { workspaceId: b.workspaceId, installationId, githubId: repositoryGithubId, trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const r of repos) {
      touched.push({ workspaceId: b.workspaceId, id: r.id });
      if (numbers.length === 0) jobs.push(repoJob(b.workspaceId, r.id));
      else for (const n of numbers) jobs.push(itemJob(b.workspaceId, r.id, n));
    }
  }
  return { jobs, touched };
}

/** `lastWebhookAt` of the installation and `lastEventAt` of each touched repository, each set at most once a minute (no hot row). */
async function stampLive(db: Db, installationId: bigint, touched: Touched[], now: Date): Promise<void> {
  const before = new Date(now.getTime() - STAMP_EVERY_MS);
  await db.githubInstallation.updateMany({ where: { installationId, OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: before } }] }, data: { lastWebhookAt: now } });
  const byWorkspace = new Map<string, string[]>();
  for (const t of touched) byWorkspace.set(t.workspaceId, [...(byWorkspace.get(t.workspaceId) ?? []), t.id]);
  for (const [workspaceId, ids] of byWorkspace) {
    for (let i = 0; i < ids.length; i += 500) await db.repository.updateMany({ where: { workspaceId, id: { in: ids.slice(i, i + 500) }, OR: [{ lastEventAt: null }, { lastEventAt: { lt: before } }] }, data: { lastEventAt: now } });
  }
}
