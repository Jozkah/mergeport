import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { attention, type AttentionQueues, type DerivedItem } from "./queries";

/**
 * The actionable inbox: pull requests that need something from the viewer, with personal done / unread / snooze state.
 *
 * Built on the Attention queues, so there is one source of truth for "who has to act". The state here is personal and local;
 * handling an inbox entry never approves, resolves or changes anything on GitHub or in shared planning.
 *
 * Every marker remembers the item's *version*, a fingerprint of the events that matter to the viewer: the head commit, the newest
 * activity by someone else, and the viewer's own open review request. A done or snoozed item comes back when the version moves on.
 */

export type InboxStatus = "open" | "snoozed" | "done";
export type InboxEntry = { item: DerivedItem["item"]; derived: DerivedItem; reasons: ("needs-review" | "changes-requested")[]; version: string; unread: boolean; status: InboxStatus; snoozeUntil: Date | null };

const SUBJECT = "work-item";

export function itemVersion(d: DerivedItem, login: string): string {
  const me = login.toLowerCase();
  const others = d.item.comments.filter((c) => c.authorLogin?.toLowerCase() !== me);
  const lastOther = others.reduce((m, c) => Math.max(m, c.updatedAtGh.getTime(), c.createdAtGh.getTime()), 0);
  const myRequest = d.item.reviewRequests.filter((r) => !r.removedAt && r.kind === "USER" && r.reviewerRef.toLowerCase() === me).reduce((m, r) => Math.max(m, r.requestedAt.getTime()), 0);
  return `${d.item.headSha ?? "-"}|${lastOther}|${myRequest}`;
}

export async function inbox(db: Db, v: Viewer, opts: { now?: Date; status?: InboxStatus; projectId?: string | null; repositoryIds?: string[]; queues?: AttentionQueues } = {}): Promise<{ entries: InboxEntry[]; counts: Record<InboxStatus, number>; unread: number }> {
  const now = opts.now ?? new Date();
  const q = opts.queues ?? (await attention(db, v, { now, projectId: opts.projectId, repositoryIds: opts.repositoryIds }));
  const byId = new Map<string, { d: DerivedItem; reasons: InboxEntry["reasons"] }>();
  const add = (list: DerivedItem[], reason: InboxEntry["reasons"][number]) => {
    for (const d of list) (byId.get(d.item.id) ?? byId.set(d.item.id, { d, reasons: [] }).get(d.item.id)!).reasons.push(reason);
  };
  add(q.needsMyReview, "needs-review");
  add(q.changesRequested, "changes-requested");
  const states = new Map((await db.inboxState.findMany({ where: { userId: v.userId, subjectType: SUBJECT, subjectId: { in: [...byId.keys()] } } })).map((s) => [s.subjectId, s]));

  const all: InboxEntry[] = [];
  for (const { d, reasons } of byId.values()) {
    const version = itemVersion(d, v.login);
    const s = states.get(d.item.id);
    const done = !!s && s.doneVersion === version;
    const snoozed = !done && !!s?.snoozeUntil && s.snoozeUntil > now && s.snoozeVersion === version;
    all.push({ item: d.item, derived: d, reasons, version, unread: s?.readVersion !== version, status: done ? "done" : snoozed ? "snoozed" : "open", snoozeUntil: snoozed ? s!.snoozeUntil : null });
  }
  all.sort((a, b) => Number(b.unread) - Number(a.unread) || b.item.updatedAtGh.getTime() - a.item.updatedAtGh.getTime());
  const counts = { open: 0, snoozed: 0, done: 0 };
  for (const e of all) counts[e.status]++;
  return { entries: all.filter((e) => e.status === (opts.status ?? "open")), counts, unread: all.filter((e) => e.status === "open" && e.unread).length };
}

/** The viewer may only mark what they can currently see in their own inbox. */
async function current(db: Db, v: Viewer, itemId: string): Promise<InboxEntry> {
  for (const status of ["open", "snoozed", "done"] as const) {
    const hit = (await inbox(db, v, { status })).entries.find((e) => e.item.id === itemId);
    if (hit) return hit;
  }
  throw new Error("That item is not in your inbox");
}

async function write(db: Db, v: Viewer, itemId: string, data: { readVersion?: string | null; doneVersion?: string | null; snoozeUntil?: Date | null; snoozeVersion?: string | null }) {
  const where = { userId_subjectType_subjectId: { userId: v.userId, subjectType: SUBJECT, subjectId: itemId } };
  await db.inboxState.upsert({ where, create: { userId: v.userId, subjectType: SUBJECT, subjectId: itemId, ...data }, update: data });
}

export async function markRead(db: Db, v: Viewer, itemId: string) {
  const e = await current(db, v, itemId);
  await write(db, v, itemId, { readVersion: e.version });
}
export async function markAllRead(db: Db, v: Viewer) {
  for (const e of (await inbox(db, v)).entries) await write(db, v, e.item.id, { readVersion: e.version });
}
export async function markDone(db: Db, v: Viewer, itemId: string) {
  const e = await current(db, v, itemId);
  await write(db, v, itemId, { readVersion: e.version, doneVersion: e.version, snoozeUntil: null, snoozeVersion: null });
}
export async function snooze(db: Db, v: Viewer, itemId: string, until: Date) {
  const e = await current(db, v, itemId);
  await write(db, v, itemId, { readVersion: e.version, doneVersion: null, snoozeUntil: until, snoozeVersion: e.version });
}
export async function reopen(db: Db, v: Viewer, itemId: string) {
  await current(db, v, itemId);
  await write(db, v, itemId, { doneVersion: null, snoozeUntil: null, snoozeVersion: null });
}
