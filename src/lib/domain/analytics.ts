/**
 * Delivery analytics from recorded planning events. Pure.
 *
 * Nothing here is reconstructed from today's state. A measure covers only items whose start and finish were both recorded, and the
 * report says since when recording began, so a short history reads as short rather than as a wrong number.
 */
export type Ev = { itemId: string; kind: string; fromKey: string | null; toKey: string | null; refId: string | null; at: Date };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export const STARTED_KEYS = ["in-progress", "in-review"];

export type CycleTime = { count: number; medianMs: number | null; p85Ms: number | null; skipped: number };

/** Time from first entering a started column to the last move into done, for items that have both events. */
export function cycleTimes(events: Ev[]): CycleTime {
  const by = new Map<string, Ev[]>();
  for (const e of events) (by.get(e.itemId) ?? by.set(e.itemId, []).get(e.itemId)!).push(e);
  const spans: number[] = [];
  let skipped = 0;
  for (const evs of by.values()) {
    const sorted = [...evs].sort((a, b) => a.at.getTime() - b.at.getTime());
    const done = [...sorted].reverse().find((e) => e.kind === "done");
    if (!done) continue;
    const start = sorted.find((e) => e.kind === "moved" && e.toKey && STARTED_KEYS.includes(e.toKey) && e.at <= done.at);
    if (!start) {
      skipped++; // finished, but its start was never recorded: not guessed
      continue;
    }
    spans.push(done.at.getTime() - start.at.getTime());
  }
  return { count: spans.length, medianMs: spans.length ? median(spans) : null, p85Ms: spans.length ? percentile(spans, 85) : null, skipped };
}

export type Aging = { itemId: string; columnKey: string; sinceMs: number };

/** How long each unfinished item has been in its current column, only where the entry into it was recorded. */
export function agingWip(items: { id: string; columnKey: string }[], events: Ev[], now: Date): { aging: Aging[]; unrecorded: number } {
  const last = new Map<string, Ev>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) if ((e.kind === "moved" || e.kind === "created" || e.kind === "reopened") && e.toKey) last.set(e.itemId, e);
  const aging: Aging[] = [];
  let unrecorded = 0;
  for (const it of items) {
    if (it.columnKey === "done" || it.columnKey === "backlog") continue;
    const e = last.get(it.id);
    if (!e || e.toKey !== it.columnKey) {
      unrecorded++;
      continue;
    }
    aging.push({ itemId: it.id, columnKey: it.columnKey, sinceMs: Math.max(0, now.getTime() - e.at.getTime()) });
  }
  return { aging: aging.sort((a, b) => b.sinceMs - a.sinceMs), unrecorded };
}

/** Items put into a milestone after it started (by a recorded event), against those present from the start. */
export function scopeAdded(events: Ev[], milestoneId: string, startsAt: Date | null): { added: number; atStart: number } | null {
  if (!startsAt) return null;
  const into = events.filter((e) => e.kind === "milestone" && e.refId === milestoneId);
  const firstFor = new Map<string, Date>();
  for (const e of into) if (!firstFor.has(e.itemId) || e.at < firstFor.get(e.itemId)!) firstFor.set(e.itemId, e.at);
  let added = 0;
  let atStart = 0;
  for (const at of firstFor.values()) {
    if (at > startsAt) added++;
    else atStart++;
  }
  return { added, atStart };
}

export const recordingSince = (events: Ev[]): Date | null => (events.length ? events.reduce((m, e) => (e.at < m ? e.at : m), events[0].at) : null);
