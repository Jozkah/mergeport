import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { INSTALLATION_ACTIONS, applyInstallationEvent, applyRepositoriesRemoved } from "./webhook-lifecycle";

/**
 * What a verified GitHub App delivery does here (docs/github-app.md, "Webhooks"). Called by the route AFTER the signature was checked.
 *
 * Ids in a payload only FIND our own rows: the installation id must already be a `GithubInstallation` we hold (a webhook never creates a
 * binding or an installation), and a repository id only matches repositories whose `installationId` is that same installation, in each
 * workspace bound to it. A validly signed payload that names another installation's repositories therefore matches nothing.
 *
 * Handlers only flip states and queue jobs (the existing `sync.item` / `sync.repository` jobs with their dedupe keys); GitHub is never
 * called here, so the answer is fast. The delivery row, the `lastWebhookAt` stamp and every write of the handler share ONE transaction:
 * a failure rolls all of it back, so GitHub's redelivery of the same id is processed normally.
 */

export type DeliveryResult =
  | { kind: "ignored" } //                 an event or action this deployment does not act on: no writes
  | { kind: "bad-payload" } //             a handled event without a usable installation id
  | { kind: "unknown-installation" } //    not an installation we hold: no writes
  | { kind: "duplicate" } //               this delivery id was already handled: no writes
  | { kind: "accepted"; jobs: number; lifecycle: boolean };

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

export const HANDLED_EVENTS = new Set([...Object.keys(ITEM_NUMBER), ...REPOSITORY_EVENTS, "repository", "installation", "installation_repositories"]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
const id = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null);
/** At most 10 distinct pull request numbers of a check's `pull_requests` list. */
const pullNumbers = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.slice(0, 25).map((x) => num(obj(x)?.number)).filter((n) => n > 0))].slice(0, 10) : []);

/** What a delivery would do, decided from the event name and payload alone (no database): used by the route to answer 202 for the irrelevant. */
export function isRelevant(event: string, payload: Obj): boolean {
  if (!HANDLED_EVENTS.has(event)) return false;
  const action = typeof payload.action === "string" ? payload.action : "";
  if (event === "repository") return REPOSITORY_ACTIONS.has(action);
  if (event === "installation") return INSTALLATION_ACTIONS.has(action);
  if (event === "installation_repositories") return action === "removed" || action === "added";
  return true;
}

export async function processDelivery(db: Db, input: { deliveryId: string; event: string; payload: Obj; now?: Date }): Promise<DeliveryResult> {
  const { deliveryId, event, payload } = input;
  const now = input.now ?? new Date();
  if (!isRelevant(event, payload)) return { kind: "ignored" };
  const installationId = id(obj(payload.installation)?.id);
  if (installationId === null) return { kind: "bad-payload" };

  return db.$transaction(
    async (tx): Promise<DeliveryResult> => {
      const installation = await tx.githubInstallation.findUnique({ where: { installationId }, select: { installationId: true, suspendedAt: true, deletedAt: true } });
      if (!installation) return { kind: "unknown-installation" };
      // ON CONFLICT DO NOTHING: a repeated id is a no-op, and (unlike a thrown unique violation) leaves the transaction usable.
      const fresh = await tx.githubDelivery.createMany({ data: [{ deliveryId, installationId, event, receivedAt: now }], skipDuplicates: true });
      if (fresh.count === 0) return { kind: "duplicate" };
      await tx.githubInstallation.update({ where: { installationId }, data: { lastWebhookAt: now } });

      const action = typeof payload.action === "string" ? payload.action : "";
      if (event === "installation") {
        await applyInstallationEvent(tx, installation, action, now);
        return { kind: "accepted", jobs: 0, lifecycle: true };
      }
      if (event === "installation_repositories") {
        if (action === "removed") await applyRepositoriesRemoved(tx, installationId, payload.repositories_removed);
        return { kind: "accepted", jobs: 0, lifecycle: true }; // "added": admins choose what to track, nothing to do
      }

      const repositoryGithubId = id(obj(payload.repository)?.id);
      if (repositoryGithubId === null) return { kind: "accepted", jobs: 0, lifecycle: false };
      const numbers = ITEM_NUMBER[event]?.(payload).filter((n) => n > 0) ?? [];
      const bindings = await tx.workspaceInstallation.findMany({ where: { installationId }, select: { workspaceId: true }, orderBy: { workspaceId: "asc" } });
      let jobs = 0;
      for (const b of bindings) {
        // The repository rows of THIS workspace that this installation serves. Another installation's, or an untracked one, matches nothing.
        const repos = await tx.repository.findMany({
          where: { workspaceId: b.workspaceId, installationId, githubId: repositoryGithubId, trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        for (const r of repos) jobs += await queue(tx, b.workspaceId, r.id, event === "repository" || numbers.length === 0 ? [] : numbers);
      }
      return { kind: "accepted", jobs, lifecycle: false };
    },
    { timeout: 10_000, maxWait: 5_000 },
  );
}

/**
 * Queues the refresh for one repository row: one `sync.item` per number (dedupe `item:<repository>:<number>`), or the repository's own
 * `sync.repository` (dedupe `sync:<repository>`, the key reconcile and the Refresh button share, so bursts coalesce into one run).
 */
async function queue(tx: Prisma.TransactionClient, workspaceId: string, repositoryId: string, numbers: number[]): Promise<number> {
  if (numbers.length === 0) {
    await enqueue(tx, { type: "sync.repository", payload: { repositoryId }, dedupeKey: `sync:${repositoryId}`, workspaceId });
    return 1;
  }
  for (const n of numbers) await enqueue(tx, { type: "sync.item", payload: { repositoryId, number: n }, dedupeKey: `item:${repositoryId}:${n}`, workspaceId });
  return numbers.length;
}
