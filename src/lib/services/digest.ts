import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { loadViewer, repoWhere, viaRepo, type Viewer } from "@/lib/authz/viewer";
import { ageDays, dayStart, digestDue, DIGEST_STALE_REQUEST_DAYS, isDay, reportedDay, shiftDay } from "@/lib/domain/digest";
import { isDemo } from "@/lib/env";
import { indexNeedle, sameLogin } from "@/lib/domain/text-index";
import { wantsInApp } from "@/lib/domain/notify-prefs";
import { inbox } from "./inbox";
import { getPrefs } from "./notification-prefs";
import { attention, planningWhere, type AttentionQueues } from "./queries";
import { upstreamUpdateAttention } from "./upstream-update";

/**
 * The daily digest: what was done yesterday, what was left undone, and what needs the person's attention or other people's.
 *
 * DETERMINISTIC and LOCAL: built only from this computer's database, with the same viewer scoping as every other page (a repository the
 * person cannot see never contributes an entry, a count or a title). No network, no model, nothing is written to GitHub.
 *
 * Extension point: a SOURCE is a function that returns extra entries per section. Other modules register one with
 * `registerDigestSource` (a source is responsible for scoping what it returns to the viewer); `buildDigest` also accepts sources
 * directly. A source that throws is skipped, it never stops the digest.
 */

export const DIGEST_SECTION_CAP = 15;

export type DigestEntry = {
  /** Stable within a section; entries with the same key are shown once. */
  key: string;
  title: string;
  repo: string | null;
  /** Internal link only (a page of this app). */
  href: string;
  reason: string;
  /** The person the entry is waiting on, for the "others" section. */
  who?: string | null;
  /** ISO instant the entry dates from (event time, request time, due date), and its age in whole days at generation. */
  since: string | null;
  ageDays: number | null;
};
export type DigestSection = { entries: DigestEntry[]; total: number; more: number };
export type DigestPayload = {
  version: 1;
  day: string;
  timezone: string;
  window: { start: string; end: string };
  done: DigestSection;
  undone: DigestSection;
  attention: { mine: DigestSection; others: DigestSection };
  counts: { done: number; undone: number; mine: number; others: number };
};

export type DigestKind = "done" | "undone" | "mine" | "others";
export type DigestContext = { db: Db; viewer: Viewer; now: Date; timezone: string; day: string; start: Date; end: Date };
export type DigestSource = (ctx: DigestContext) => Promise<Partial<Record<DigestKind, DigestEntry[]>>>;

const registry = new Map<string, DigestSource>();
/** Adds a source under a unique name (registering the same name again replaces it). Returns a function that removes it. */
export function registerDigestSource(name: string, source: DigestSource): () => void {
  registry.set(name, source);
  return () => void registry.delete(name);
}

const workHref = (r: { id: string; type: string }) => (r.type === "PULL_REQUEST" ? `/pull-requests/${r.id}` : `/issues/${r.id}`);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function entry(ctx: DigestContext, e: Omit<DigestEntry, "since" | "ageDays"> & { since?: Date | null }): DigestEntry {
  const { since, ...rest } = e;
  return { ...rest, since: iso(since), ageDays: ageDays(since ?? null, ctx.now) };
}

const REVIEW_WORD: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Asked for changes on", COMMENTED: "Reviewed", DISMISSED: "Reviewed" };

// ---------- sections ----------

async function doneEntries(ctx: DigestContext): Promise<DigestEntry[]> {
  const { db, viewer: v, start, end } = ctx;
  const win = { gte: start, lt: end };
  const mine = <T extends { authorLogin: string | null; assigneeLogins: string }>(r: T) => sameLogin(r.authorLogin, v.login) || r.assigneeLogins.includes(indexNeedle(v.login));
  const out: DigestEntry[] = [];

  // Tasks that moved to the done column that day, by the person or assigned to them, and are still done.
  const events = await db.planEvent.findMany({ where: { kind: "done", at: win }, select: { itemId: true, actorLogin: true, at: true }, orderBy: { at: "asc" } });
  if (events.length) {
    const actor = new Map(events.map((e) => [e.itemId, e])); // the latest event of each task wins
    const tasks = await db.planningItem.findMany({
      where: { AND: [await planningWhere(db, v), { id: { in: [...actor.keys()] } }] },
      include: { column: true, project: { select: { name: true } }, workItem: { select: { repository: { select: { fullName: true } } } } },
    });
    for (const t of tasks) {
      if (t.column.key !== "done" || !(sameLogin(actor.get(t.id)?.actorLogin, v.login) || sameLogin(t.assigneeLogin, v.login))) continue;
      out.push(entry(ctx, { key: `task:${t.id}`, title: t.title, repo: t.workItem?.repository.fullName ?? null, href: `/tasks/${t.id}`, reason: `Task finished in ${t.project.name}`, since: actor.get(t.id)?.at }));
    }
  }

  const items = await db.workItem.findMany({
    where: { ...viaRepo(v), OR: [{ type: "PULL_REQUEST", state: "MERGED", mergedAtGh: win }, { type: "ISSUE", state: "CLOSED", closedAtGh: win }] },
    include: { repository: { select: { fullName: true } } },
  });
  for (const r of items) {
    if (!mine(r)) continue;
    const pr = r.type === "PULL_REQUEST";
    out.push(entry(ctx, { key: `wi:${r.id}`, title: r.title, repo: r.repository.fullName, href: workHref(r), reason: pr ? "Your pull request was merged" : "Issue closed", since: pr ? r.mergedAtGh : r.closedAtGh }));
  }

  // Reviews the person gave, once per pull request (the latest one that day).
  const reviews = await db.workItemComment.findMany({
    where: { kind: "REVIEW", authorLogin: { contains: v.login }, createdAtGh: win, workItem: viaRepo(v) },
    orderBy: { createdAtGh: "desc" },
    include: { workItem: { select: { id: true, type: true, number: true, title: true, repository: { select: { fullName: true } } } } },
  });
  const seen = new Set<string>();
  for (const c of reviews) {
    if (!sameLogin(c.authorLogin, v.login) || seen.has(c.workItemId) || out.some((o) => o.key === `wi:${c.workItemId}`)) continue;
    seen.add(c.workItemId);
    out.push(entry(ctx, { key: `review:${c.workItemId}`, title: c.workItem.title, repo: c.workItem.repository.fullName, href: workHref(c.workItem), reason: `${REVIEW_WORD[c.reviewState ?? ""] ?? "Reviewed"} #${c.workItem.number}`, since: c.createdAtGh }));
  }

  // Backports recorded as done (both sides of the fork mapping must be visible to the person).
  const backports = await db.backportRecord.findMany({
    where: { state: "done", updatedAt: win, mapping: { fork: repoWhere(v), upstream: repoWhere(v) } },
    include: { mapping: { include: { fork: { select: { fullName: true } } } } },
  });
  for (const b of backports) {
    if (!sameLogin(b.byLogin, v.login)) continue;
    out.push(entry(ctx, { key: `backport:${b.id}`, title: `Upstream #${b.upstreamNumber} brought to ${b.targetBranch}`, repo: b.mapping.fork.fullName, href: "/forks", reason: "Backport marked done", since: b.updatedAt }));
  }
  return out;
}

async function undoneEntries(ctx: DigestContext): Promise<DigestEntry[]> {
  const { db, viewer: v } = ctx;
  // Due dates are calendar dates: due on the reported day or before means before the next day starts.
  const todayUtc = new Date(shiftDay(ctx.day, 1) + "T00:00:00Z");
  const out: DigestEntry[] = [];

  // Open items assigned to the person, and the person's own open pull requests (drafts are not "waiting" yet).
  const open = await db.workItem.findMany({
    where: { ...viaRepo(v), state: "OPEN", OR: [{ assigneeLogins: { contains: indexNeedle(v.login) } }, { type: "PULL_REQUEST", draft: false, authorLogin: { contains: v.login } }] },
    include: { repository: { select: { fullName: true } } },
  });
  const workIds = new Set<string>();
  for (const r of open) {
    const assigned = r.assigneeLogins.includes(indexNeedle(v.login));
    const authored = r.type === "PULL_REQUEST" && !r.draft && sameLogin(r.authorLogin, v.login);
    if (!assigned && !authored) continue;
    workIds.add(r.id);
    const reason = assigned && authored ? "Your pull request, assigned to you, is still open" : assigned ? (r.type === "PULL_REQUEST" ? "Pull request assigned to you is still open" : "Issue assigned to you is still open") : "Your pull request is still open";
    out.push(entry(ctx, { key: `wi:${r.id}`, title: r.title, repo: r.repository.fullName, href: workHref(r), reason, since: r.createdAtGh }));
  }

  // Tasks assigned to the person that were due, or planned in an iteration that ended, and are not done.
  const ended = await db.iteration.findMany({ where: { endDate: { lt: todayUtc }, project: { workspaceId: v.workspaceId } }, select: { id: true, name: true, endDate: true } });
  const endedBy = new Map(ended.map((i) => [i.id, i]));
  const tasks = await db.planningItem.findMany({
    where: { AND: [await planningWhere(db, v), { assigneeLogin: { in: [v.login, v.login.toLowerCase()] }, column: { key: { not: "done" } }, OR: [{ dueDate: { lt: todayUtc } }, { iterationId: { in: [...endedBy.keys()] } }] }] },
    include: { workItem: { select: { repository: { select: { fullName: true } } } } },
  });
  for (const t of tasks) {
    if (t.workItemId && workIds.has(t.workItemId)) continue; // the linked item is already listed
    const it = t.iterationId ? endedBy.get(t.iterationId) : undefined;
    const due = t.dueDate && t.dueDate < todayUtc ? t.dueDate : null;
    const since = due ?? it?.endDate ?? null;
    out.push(entry(ctx, { key: `task:${t.id}`, title: t.title, repo: t.workItem?.repository.fullName ?? null, href: `/tasks/${t.id}`, reason: due ? `Task was due ${due.toISOString().slice(0, 10)}` : `Task planned in ${it!.name}, which has ended`, since }));
  }

  // Review comments written and never sent.
  const drafts = await db.reviewDraft.findMany({ where: { userId: v.userId }, orderBy: { createdAt: "asc" } });
  if (drafts.length) {
    const items = await db.workItem.findMany({ where: { ...viaRepo(v), state: "OPEN", id: { in: [...new Set(drafts.map((d) => d.workItemId))] } }, include: { repository: { select: { fullName: true } } } });
    for (const w of items) {
      const mine = drafts.filter((d) => d.workItemId === w.id);
      out.push(entry(ctx, { key: `draft:${w.id}`, title: w.title, repo: w.repository.fullName, href: workHref(w), reason: `${mine.length} review comment${mine.length === 1 ? "" : "s"} started and not sent`, since: mine[0].createdAt }));
    }
  }
  return out;
}

async function mineEntries(ctx: DigestContext, q: AttentionQueues): Promise<DigestEntry[]> {
  const { db, viewer: v } = ctx;
  const out: DigestEntry[] = [];
  for (const d of q.needsMyReview) out.push(entry(ctx, { key: `review:${d.item.id}`, title: d.item.title, repo: d.item.repository.fullName, href: workHref(d.item), reason: "Waiting for your review", since: d.derivation.waiting?.since ?? d.item.createdAtGh }));
  for (const d of q.changesRequested) out.push(entry(ctx, { key: `changes:${d.item.id}`, title: d.item.title, repo: d.item.repository.fullName, href: workHref(d.item), reason: "A reviewer asked for changes on your pull request", since: d.item.updatedAtGh }));

  const mine = await db.workItem.findMany({ where: { ...viaRepo(v), state: "OPEN", type: "PULL_REQUEST", authorLogin: { contains: v.login }, OR: [{ checksState: "FAILURE" }, { mergeable: "CONFLICTING" }] }, include: { repository: { select: { fullName: true } } } });
  for (const r of mine) {
    if (!sameLogin(r.authorLogin, v.login)) continue;
    if (r.checksState === "FAILURE") out.push(entry(ctx, { key: `checks:${r.id}`, title: r.title, repo: r.repository.fullName, href: workHref(r), reason: "Checks are failing on your pull request", since: r.updatedAtGh }));
    if (r.mergeable === "CONFLICTING") out.push(entry(ctx, { key: `conflict:${r.id}`, title: r.title, repo: r.repository.fullName, href: workHref(r), reason: "Your pull request has merge conflicts", since: r.updatedAtGh }));
  }

  const unread = (await inbox(db, v, { now: ctx.now, queues: q })).unread;
  if (unread > 0) out.push(entry(ctx, { key: "inbox", title: `${unread} unread inbox item${unread === 1 ? "" : "s"}`, repo: null, href: "/inbox", reason: "New since you last looked" }));

  const [conflicts, restores] = await Promise.all([db.syncConflict.count({ where: { status: "OPEN" } }), db.hubRestore.count({ where: { status: "OPEN" } })]);
  if (conflicts > 0) out.push(entry(ctx, { key: "sync-conflicts", title: `${conflicts} sync conflict${conflicts === 1 ? "" : "s"} to resolve`, repo: null, href: "/sync", reason: "Your edit and a teammate's disagree" }));
  if (restores > 0) out.push(entry(ctx, { key: "hub-restores", title: `${restores} restored-server decision${restores === 1 ? "" : "s"}`, repo: null, href: "/sync", reason: "The team server was restored from a backup" }));

  const repos = await db.repository.findMany({ where: { AND: [repoWhere(v), { OR: [{ syncError: { not: null } }, { trackingStatus: "DISCONNECTED" }] }] }, orderBy: { fullName: "asc" } });
  for (const r of repos) out.push(entry(ctx, { key: `repo:${r.id}`, title: r.fullName, repo: r.fullName, href: `/repositories/${r.id}`, reason: r.trackingStatus === "DISCONNECTED" ? `Disconnected${r.statusDetail ? `: ${r.statusDetail}` : ""}` : `Sync is failing: ${r.syncError}`, since: r.lastSyncedAt }));
  return out;
}

async function othersEntries(ctx: DigestContext): Promise<DigestEntry[]> {
  const { db, viewer: v, now } = ctx;
  const out: DigestEntry[] = [];
  const staleBefore = new Date(now.getTime() - DIGEST_STALE_REQUEST_DAYS * 86_400_000);

  // Manual and rule-made waiting records on the person's own pull requests, issues and tasks.
  const records = await db.waitingRecord.findMany({
    where: {
      workspaceId: v.workspaceId,
      status: "PENDING",
      OR: [
        { workItem: { ...viaRepo(v), OR: [{ authorLogin: { contains: v.login } }, { assigneeLogins: { contains: indexNeedle(v.login) } }] } },
        { planningItem: { AND: [await planningWhere(db, v), { OR: [{ assigneeLogin: { in: [v.login, v.login.toLowerCase()] } }, { authorLogin: { in: [v.login, v.login.toLowerCase()] } }] }] } },
      ],
    },
    include: { workItem: { include: { repository: { select: { fullName: true } } } }, planningItem: { include: { workItem: { select: { repository: { select: { fullName: true } } } } } } },
  });
  for (const w of records) {
    if (sameLogin(w.reviewerRef, v.login)) continue;
    const wi = w.workItem;
    if (wi && !(sameLogin(wi.authorLogin, v.login) || wi.assigneeLogins.includes(indexNeedle(v.login)))) continue;
    const title = wi?.title ?? w.planningItem?.title ?? "";
    out.push(entry(ctx, { key: `wait:${wi?.id ?? w.planningItemId}:${w.reviewerRef.toLowerCase()}`, title, repo: wi?.repository.fullName ?? w.planningItem?.workItem?.repository.fullName ?? null, href: wi ? workHref(wi) : `/tasks/${w.planningItemId}`, reason: `Waiting on ${w.reviewerRef}: ${w.reason}`, who: w.reviewerRef, since: w.startedAt }));
  }

  // Review requests on the person's open pull requests that nobody answered for a while.
  const prs = await db.workItem.findMany({
    where: { ...viaRepo(v), state: "OPEN", type: "PULL_REQUEST", draft: false, authorLogin: { contains: v.login }, reviewRequests: { some: { removedAt: null, requestedAt: { lt: staleBefore } } } },
    include: { repository: { select: { fullName: true } }, reviewRequests: true, comments: { where: { kind: "REVIEW" } } },
  });
  for (const r of prs) {
    if (!sameLogin(r.authorLogin, v.login)) continue;
    for (const q of r.reviewRequests) {
      if (q.removedAt || q.requestedAt >= staleBefore || q.kind === "EXTERNAL_ROLE") continue;
      if (r.comments.some((c) => sameLogin(c.authorLogin, q.reviewerRef) && c.createdAtGh >= q.requestedAt)) continue; // they answered
      const who = q.kind === "TEAM" ? `team ${q.reviewerRef}` : q.reviewerRef;
      const days = ageDays(q.requestedAt, now) ?? 0;
      out.push(entry(ctx, { key: `wait:${r.id}:${q.reviewerRef.toLowerCase()}`, title: r.title, repo: r.repository.fullName, href: workHref(r), reason: `${who} has not reviewed for ${days} day${days === 1 ? "" : "s"}`, who: q.reviewerRef, since: q.requestedAt }));
    }
  }
  return out;
}

// ---------- assembly ----------

const time = (e: DigestEntry) => (e.since ? Date.parse(e.since) : null);
const newestFirst = (a: DigestEntry, b: DigestEntry) => (time(b) ?? -Infinity) - (time(a) ?? -Infinity);
const oldestFirst = (a: DigestEntry, b: DigestEntry) => (time(a) ?? Infinity) - (time(b) ?? Infinity);

function section(entries: DigestEntry[], order: ((a: DigestEntry, b: DigestEntry) => number) | null, cap: number): DigestSection {
  const seen = new Set<string>();
  const unique = entries.filter((e) => !seen.has(e.key) && !!seen.add(e.key));
  if (order) unique.sort(order); // stable: equal ages keep their source order
  return { entries: unique.slice(0, cap), total: unique.length, more: Math.max(0, unique.length - cap) };
}

const UPDATE_LOOKBACK_DAYS = 7;
const UPDATE_REASON: Record<string, string> = {
  conflict: "Upstream update stopped on a merge conflict",
  "verify-failed": "Upstream update failed its verification",
  failed: "Upstream update failed",
  "pr-opened": "Upstream update is waiting for review",
  "merged-untested": "Upstream update is waiting for review (not verified)",
};
/** Upstream auto-update runs that need the person: the latest settled run of each fork, when it is a problem or a pull request to review. */
const upstreamUpdateSource: DigestSource = async (ctx) => {
  const since = new Date(ctx.end.getTime() - UPDATE_LOOKBACK_DAYS * 86_400_000);
  const runs = await upstreamUpdateAttention(ctx.db, ctx.viewer, { since });
  return {
    mine: runs.map((r) => entry(ctx, { key: `upstream-update:${r.mappingId}`, title: `${r.upstream} into ${r.fork}`, repo: r.fork, href: "/forks", reason: UPDATE_REASON[r.state] ?? "Upstream update needs you", since: r.finishedAt })),
  };
};

export type BuildOptions = { now?: Date; tz?: string; /** The local day to report; default: the day before `now`. */ day?: string; cap?: number; sources?: DigestSource[] };

export async function buildDigest(db: Db, viewer: Viewer, opts: BuildOptions = {}): Promise<DigestPayload> {
  const now = opts.now ?? new Date();
  const timezone = opts.tz ?? viewer.timezone;
  if (opts.day !== undefined && !isDay(opts.day)) throw new Error(`Not a calendar date: ${opts.day}`);
  const reported = opts.day ?? reportedDay(now, timezone).day;
  const ctx: DigestContext = { db, viewer, now, timezone, day: reported, start: dayStart(reported, timezone), end: dayStart(shiftDay(reported, 1), timezone) };
  const q = await attention(db, viewer, { now });
  const [done, undone, mine, others] = await Promise.all([doneEntries(ctx), undoneEntries(ctx), mineEntries(ctx, q), othersEntries(ctx)]);
  const extra: Record<DigestKind, DigestEntry[]> = { done: [], undone: [], mine: [], others: [] };
  for (const source of [upstreamUpdateSource, ...registry.values(), ...(opts.sources ?? [])]) {
    try {
      const r = await source(ctx);
      for (const k of Object.keys(extra) as DigestKind[]) extra[k].push(...(r[k] ?? []));
    } catch (e) {
      console.error("digest source failed", e instanceof Error ? e.message : e);
    }
  }
  const cap = opts.cap ?? DIGEST_SECTION_CAP;
  const s = {
    done: section([...done, ...extra.done], newestFirst, cap),
    undone: section([...undone, ...extra.undone], oldestFirst, cap),
    mine: section([...mine, ...extra.mine], null, cap),
    others: section([...others, ...extra.others], oldestFirst, cap),
  };
  return {
    version: 1,
    day: reported,
    timezone,
    window: { start: ctx.start.toISOString(), end: ctx.end.toISOString() },
    done: s.done,
    undone: s.undone,
    attention: { mine: s.mine, others: s.others },
    counts: { done: s.done.total, undone: s.undone.total, mine: s.mine.total, others: s.others.total },
  };
}

// ---------- storage ----------

export const digestHref = (day: string) => `/digest?day=${day}`;
const DIGEST_KIND = "daily-digest";

export function digestSummary(c: DigestPayload["counts"]): string {
  return `${c.done} done, ${c.undone} left undone, ${c.mine} need you, ${c.others} waiting on others`;
}

export type StoredDigest = { id: string; day: string; generatedAt: Date; readAt: Date | null; payload: DigestPayload };
const stored = (r: { id: string; day: string; generatedAt: Date; readAt: Date | null; payload: unknown }): StoredDigest | null => {
  const p = r.payload as DigestPayload | null;
  return p && p.version === 1 ? { id: r.id, day: r.day, generatedAt: r.generatedAt, readAt: r.readAt, payload: p } : null;
};

export async function getDigest(db: Db, userId: string, day: string): Promise<StoredDigest | null> {
  const r = await db.dailyDigest.findUnique({ where: { userId_day: { userId, day } } });
  return r ? stored(r) : null;
}

/** Days that have a stored digest, newest first. */
export async function listDigestDays(db: Db, userId: string, take = 60): Promise<{ day: string; readAt: Date | null }[]> {
  return db.dailyDigest.findMany({ where: { userId }, orderBy: { day: "desc" }, take, select: { day: true, readAt: true } });
}

/**
 * The newest stored digest. Demo mode has no scheduler (nothing runs there), so the first one is made on demand from the demo data.
 */
export async function latestDigest(db: Db, viewer: Viewer, now = new Date()): Promise<StoredDigest | null> {
  const newest = await db.dailyDigest.findFirst({ where: { userId: viewer.userId }, orderBy: { day: "desc" } });
  if (!newest && isDemo()) return (await generateDigest(db, viewer, { now })).digest;
  return newest ? stored(newest) : null;
}

export async function unreadDigestCount(db: Db, userId: string): Promise<number> {
  return db.dailyDigest.count({ where: { userId, readAt: null } });
}

export async function markDigestRead(db: Db, userId: string, day: string, now = new Date()): Promise<void> {
  await db.dailyDigest.updateMany({ where: { userId, day, readAt: null }, data: { readAt: now } });
  await db.notification.updateMany({ where: { userId, kind: DIGEST_KIND, href: digestHref(day), readAt: null }, data: { readAt: now } });
}

/**
 * Generates the digest for the day before `now` and stores it. Never generates twice for a day: an existing digest is returned as is
 * (`created: false`) unless `replace` is set, which only the Regenerate button does. The notification is created once, with the first
 * digest of a day, and only if the person did not turn that kind off.
 */
export async function generateDigest(db: Db, viewer: Viewer, opts: BuildOptions & { replace?: boolean } = {}): Promise<{ digest: StoredDigest; created: boolean }> {
  const now = opts.now ?? new Date();
  const day = opts.day ?? reportedDay(now, opts.tz ?? viewer.timezone).day;
  const existing = await getDigest(db, viewer.userId, day);
  if (existing && !opts.replace) return { digest: existing, created: false };
  const payload = await buildDigest(db, viewer, { ...opts, now, day });
  const json = payload as unknown as Prisma.InputJsonValue;
  if (existing) {
    const row = await db.dailyDigest.update({ where: { id: existing.id }, data: { payload: json, generatedAt: now, readAt: null } });
    return { digest: stored(row)!, created: false };
  }
  let row;
  try {
    row = await db.dailyDigest.create({ data: { userId: viewer.userId, day, payload: json, generatedAt: now } });
  } catch {
    const raced = await getDigest(db, viewer.userId, day); // another caller stored it between our read and write
    if (raced) return { digest: raced, created: false };
    throw new Error("Could not store the digest");
  }
  if (wantsInApp(await getPrefs(db, viewer.userId), DIGEST_KIND)) {
    await db.notification.create({ data: { workspaceId: viewer.workspaceId, userId: viewer.userId, kind: DIGEST_KIND, title: `Digest for ${day}: ${digestSummary(payload.counts)}`, href: digestHref(day) } });
  }
  return { digest: stored(row)!, created: true };
}

export type DigestRun = "generated" | "disabled" | "not-yet" | "have-it" | "no-profile";

/**
 * One scheduler check, safe to repeat every few minutes (and the catch-up after the app was closed at the configured hour): generates
 * the digest of the previous local day when the hour has passed and none exists. Reads only the local database.
 */
export async function runDailyDigest(db: Db, now = new Date()): Promise<DigestRun> {
  const user = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  const viewer = user ? await loadViewer(db, user.id) : null;
  if (!viewer) return "no-profile";
  const { digest: settings } = await getPrefs(db, viewer.userId);
  const { day } = reportedDay(now, viewer.timezone);
  const haveDay = (await db.dailyDigest.count({ where: { userId: viewer.userId, day } })) > 0;
  if (!settings.enabled) return "disabled";
  if (haveDay) return "have-it";
  if (!digestDue({ now, tz: viewer.timezone, settings, haveDay })) return "not-yet";
  return (await generateDigest(db, viewer, { now })).created ? "generated" : "have-it";
}
