/**
 * Dependency behaviour, stated once.
 *
 * - Kinds: "blocks" holds work back and is cycle-checked. "related" and "duplicates" only connect and never block.
 * - A blocker is finished only when its card is in the done column AND it does not follow a pull request that was closed without
 *   merging. An abandoned PR did not deliver the dependency.
 * - Hidden endpoints stay opaque: they count as blockers (so a person is never told "nothing is blocking this" wrongly) but their
 *   identity, title and links are never exposed.
 */
export const LINK_KINDS = ["blocks", "related", "duplicates"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const isLinkKind = (k: string): k is LinkKind => (LINK_KINDS as readonly string[]).includes(k);

export type BlockerFacts = { columnKey: string; workType: "ISSUE" | "PULL_REQUEST" | null; workState: "OPEN" | "CLOSED" | "MERGED" | null };

export function blockerFinished(b: BlockerFacts): boolean {
  if (b.columnKey !== "done") return false;
  if (b.workType === "PULL_REQUEST" && b.workState === "CLOSED") return false; // closed, never merged
  return true;
}

export type Edge = { from: string; to: string; kind: LinkKind };

/** Would adding `from blocks to` create a cycle among "blocks" edges? Related and duplicate links never can. */
export function blocksCycle(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) if (e.kind === "blocks") (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(next.get(n) ?? []));
  }
  return false;
}

/**
 * For each unfinished item, how many other unfinished items are (transitively) held back by it. The largest are the critical
 * blockers. Finished items and non-blocking links never count.
 */
export function criticalBlockers(nodes: { id: string; finished: boolean }[], edges: Edge[]): { id: string; holdsBack: number }[] {
  const open = new Set(nodes.filter((n) => !n.finished).map((n) => n.id));
  const next = new Map<string, string[]>();
  for (const e of edges) if (e.kind === "blocks" && open.has(e.from) && open.has(e.to)) (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  const out: { id: string; holdsBack: number }[] = [];
  for (const id of open) {
    const seen = new Set<string>();
    const stack = [...(next.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n) || n === id) continue;
      seen.add(n);
      stack.push(...(next.get(n) ?? []));
    }
    if (seen.size > 0) out.push({ id, holdsBack: seen.size });
  }
  return out.sort((a, b) => b.holdsBack - a.holdsBack || a.id.localeCompare(b.id));
}

/** Layer for a left-to-right drawing: the longest chain of blockers before this item. Cycles cannot exist, but depth is bounded anyway. */
export function layers(ids: string[], edges: Edge[]): Map<string, number> {
  const blockers = new Map<string, string[]>();
  for (const e of edges) if (e.kind === "blocks") (blockers.get(e.to) ?? blockers.set(e.to, []).get(e.to)!).push(e.from);
  const memo = new Map<string, number>();
  const depth = (id: string, guard: number): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (guard > 50) return 0;
    const d = Math.max(-1, ...(blockers.get(id) ?? []).map((b) => depth(b, guard + 1))) + 1;
    memo.set(id, d);
    return d;
  };
  for (const id of ids) depth(id, 0);
  return memo;
}
