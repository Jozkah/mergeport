import { ValidationError } from "@/lib/errors";

/**
 * Named boards over a project's cards. A board chooses which of the project's columns to show, in what order, under which labels,
 * with optional work-in-progress limits. It never copies cards: every board shows the same planning records.
 * WIP limits are advice for the team: a column over its limit is flagged, nothing is blocked.
 */
export type BoardColumn = { key: string; name?: string; wip?: number | null };
export const GROUPINGS = ["none", "repository", "assignee", "milestone", "epic"] as const;
export type GroupBy = (typeof GROUPINGS)[number];
export const DENSITIES = ["comfortable", "compact"] as const;

export type BoardTemplate = { key: string; name: string; description: string; columns: BoardColumn[] };

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { key: "delivery", name: "Delivery", description: "Work from backlog to done, with review as its own step.", columns: [{ key: "backlog" }, { key: "ready" }, { key: "in-progress", wip: 5 }, { key: "in-review", wip: 4 }, { key: "done" }] },
  { key: "maintenance", name: "Maintenance", description: "Triage and fix, with a column for what is stuck.", columns: [{ key: "backlog", name: "Triage" }, { key: "ready", name: "Accepted" }, { key: "in-progress", name: "Fixing", wip: 4 }, { key: "blocked", name: "Stuck" }, { key: "done" }] },
  { key: "external", name: "External contributions", description: "Changes that wait on someone outside the team.", columns: [{ key: "ready", name: "Proposed" }, { key: "in-progress", name: "Being prepared" }, { key: "in-review", name: "With the maintainer" }, { key: "blocked", name: "Waiting upstream" }, { key: "done", name: "Merged" }] },
  { key: "release", name: "Release", description: "What has to land before a release goes out.", columns: [{ key: "ready", name: "Candidates" }, { key: "in-progress", name: "Landing" }, { key: "in-review", name: "Verifying" }, { key: "blocked", name: "Release blockers" }, { key: "done", name: "Shipped" }] },
];

/** Validates a board's columns against the project's real columns. Keys must exist and appear once; limits are positive whole numbers. */
export function cleanBoardColumns(raw: unknown, projectKeys: string[]): BoardColumn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError("A board needs at least one column");
  if (raw.length > 12) throw new ValidationError("A board can have at most 12 columns");
  const seen = new Set<string>();
  return raw.map((c) => {
    const col = c as Partial<BoardColumn>;
    const key = String(col?.key ?? "");
    if (!projectKeys.includes(key)) throw new ValidationError(`This project has no "${key}" column`);
    if (seen.has(key)) throw new ValidationError("A column can only appear once on a board");
    seen.add(key);
    const name = typeof col.name === "string" && col.name.trim() ? col.name.trim().slice(0, 40) : undefined;
    const wip = col.wip === null || col.wip === undefined ? null : Number(col.wip);
    if (wip !== null && (!Number.isInteger(wip) || wip < 1 || wip > 99)) throw new ValidationError("A work-in-progress limit is a whole number from 1 to 99");
    return { key, ...(name ? { name } : {}), wip };
  });
}

export type WipState = "none" | "ok" | "at" | "over";
export function wipState(count: number, wip: number | null | undefined): WipState {
  if (!wip) return "none";
  return count > wip ? "over" : count === wip ? "at" : "ok";
}

export type LaneCard = { id: string; repoFullName: string | null; assignee: string | null; milestoneName: string | null; epicTitle: string | null };
export type Lane<T> = { key: string; title: string; cards: T[] };

/** Splits the same cards into swimlanes. A lane never duplicates a card; cards with no value share one "None" lane, last. */
export function groupCards<T extends LaneCard>(cards: T[], by: GroupBy): Lane<T>[] {
  if (by === "none") return [{ key: "all", title: "", cards }];
  const pick = (c: T) => (by === "repository" ? c.repoFullName : by === "assignee" ? c.assignee : by === "milestone" ? c.milestoneName : c.epicTitle);
  const none = { repository: "No repository (local tasks)", assignee: "Unassigned", milestone: "No milestone", epic: "No epic" }[by];
  const map = new Map<string, T[]>();
  for (const c of cards) {
    const k = pick(c) ?? "";
    (map.get(k) ?? map.set(k, []).get(k)!).push(c);
  }
  const lanes = [...map].filter(([k]) => k !== "").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ key: `${by}:${k}`, title: k, cards: v }));
  if (map.has("")) lanes.push({ key: `${by}:`, title: none, cards: map.get("")! });
  return lanes;
}
