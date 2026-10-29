/** Planning logic. Pure. */

export type PlanItem = {
  id: string;
  workItemId: string | null;
  columnKey: string;
  /** Issue this PR closes, when known. A PR that closes a counted issue is not a second task. */
  closesWorkItemId?: string | null;
};

export type Progress = {
  total: number;
  done: number;
  /** null when there is nothing visible to measure. */
  percent: number | null;
  label: string;
  explanation: string;
};

/**
 * Canonical progress over the items the VIEWER can see.
 * - An item is done when it sits in the "done" column. GitHub state does not move cards.
 * - Two cards for the same GitHub resource count once; a PR that closes an already counted issue counts once.
 * - Zero visible items: percent is null (not 0%, not 100%).
 */
export function computeProgress(visibleItems: PlanItem[], doneColumnKey = "done"): Progress {
  const issueKeys = new Set(visibleItems.filter((i) => i.workItemId && !i.closesWorkItemId).map((i) => i.workItemId!));
  const canon = new Map<string, boolean>();
  for (const it of visibleItems) {
    let k = it.id;
    if (it.workItemId) {
      k = it.workItemId;
      if (it.closesWorkItemId && issueKeys.has(it.closesWorkItemId)) k = it.closesWorkItemId;
    }
    const isDone = it.columnKey === doneColumnKey;
    // If duplicates disagree, the canonical item counts as done only when every card for it is done.
    canon.set(k, canon.has(k) ? canon.get(k)! && isDone : isDone);
  }
  const total = canon.size;
  const done = [...canon.values()].filter(Boolean).length;
  return {
    total,
    done,
    percent: total === 0 ? null : Math.round((done / total) * 100),
    label: "Visible work",
    explanation: "Done items out of items you can see, each GitHub issue or PR counted once. Items in repositories you cannot access are not included.",
  };
}

export type Edge = { from: string; to: string };

/** Would adding from->to (from blocks to) create a cycle? */
export function wouldCreateCycle(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  // A cycle appears iff `from` is already reachable from `to`.
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) stack.push(m);
  }
  return false;
}

/** Position for inserting between two neighbours in a fractional-index list. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return after! - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}

export function isOverdue(dueDate: Date | null, columnKey: string, todayLocalIso: string): boolean {
  if (!dueDate || columnKey === "done") return false;
  // Date-only: compare calendar dates, never instants, so timezones cannot shift a deadline.
  return dueDate.toISOString().slice(0, 10) < todayLocalIso;
}

/** Calendar date (YYYY-MM-DD) for "now" in a user's timezone. */
export function todayIn(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type MoveResult = { ok: true; version: number } | { ok: false; reason: "conflict" };

/** Optimistic concurrency check used by the board mutation. */
export function checkVersion(currentVersion: number, expectedVersion: number): MoveResult {
  return currentVersion === expectedVersion ? { ok: true, version: currentVersion + 1 } : { ok: false, reason: "conflict" };
}
