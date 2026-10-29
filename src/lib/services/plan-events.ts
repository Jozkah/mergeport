import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

type Tx = Db | Prisma.TransactionClient;

/**
 * Planning history is recorded as it happens, one row per change. Delivery analytics read only these rows, so a number is
 * never derived from today's state pretending to be history. Events made on this computer are shared with the team (entity
 * "planevent"); events that arrive from teammates are stored as received and are never recorded a second time.
 */
export type PlanEventKind = "created" | "moved" | "milestone" | "iteration" | "epic" | "carried-over" | "done" | "reopened";

export async function recordPlanEvent(tx: Tx, e: { projectId: string; itemId: string; kind: PlanEventKind; fromKey?: string | null; toKey?: string | null; refId?: string | null; actorLogin?: string | null; at?: Date }) {
  await tx.planEvent.create({ data: { projectId: e.projectId, itemId: e.itemId, kind: e.kind, fromKey: e.fromKey ?? null, toKey: e.toKey ?? null, refId: e.refId ?? null, actorLogin: e.actorLogin ?? null, at: e.at ?? new Date() } });
}

/** A column change as events: always "moved", plus "done" or "reopened" when it crosses the finish line. */
export async function recordColumnChange(tx: Tx, e: { projectId: string; itemId: string; from: string; to: string; actorLogin: string; at?: Date }) {
  if (e.from === e.to) return;
  await recordPlanEvent(tx, { ...e, kind: "moved", fromKey: e.from, toKey: e.to, at: e.at });
  if (e.to === "done") await recordPlanEvent(tx, { ...e, kind: "done", fromKey: e.from, toKey: e.to, at: e.at });
  else if (e.from === "done") await recordPlanEvent(tx, { ...e, kind: "reopened", fromKey: e.from, toKey: e.to, at: e.at });
}
