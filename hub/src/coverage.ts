import type { HubDb } from "./db";

/** Most ids handled from one delivery; the rest are ignored. */
export const MAX_COVERAGE_IDS = 5000;

/** Decimal-string ids from a list of `{ id }` objects; anything that is not a non-negative integer is skipped. */
export function repoIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list.slice(0, MAX_COVERAGE_IDS)) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) out.add(String(id));
    else if (typeof id === "string" && /^[0-9]{1,19}$/.test(id)) out.add(id);
  }
  return [...out];
}

/** Marks ids as covered; true when at least one was not covered before. */
export function markCovered(db: HubDb, ids: string[], at: number): boolean {
  if (ids.length === 0) return false;
  const insert = db.prepare("INSERT INTO github_covered (repo_id, seen_at) VALUES (?, ?) ON CONFLICT(repo_id) DO UPDATE SET seen_at = excluded.seen_at");
  const exists = db.prepare("SELECT 1 FROM github_covered WHERE repo_id = ?");
  let changed = false;
  db.transaction(() => {
    for (const id of ids) {
      if (!exists.get(id)) changed = true;
      insert.run(id, at);
    }
  })();
  return changed;
}

/** Removes ids; true when at least one row was removed. */
export function unmarkCovered(db: HubDb, ids: string[]): boolean {
  if (ids.length === 0) return false;
  const del = db.prepare("DELETE FROM github_covered WHERE repo_id = ?");
  let changed = false;
  db.transaction(() => {
    for (const id of ids) if (del.run(id).changes > 0) changed = true;
  })();
  return changed;
}

/** The covered ids among `ids`, sorted. */
export function coveredAmong(db: HubDb, ids: Iterable<string>): string[] {
  const list = [...ids];
  if (list.length === 0) return [];
  const rows = db.prepare("SELECT repo_id FROM github_covered WHERE repo_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(list)) as { repo_id: string }[];
  return rows.map((r) => r.repo_id).sort();
}

/**
 * Applies one verified delivery to the coverage table; true when the set changed. Never throws.
 * `installation` and `installation_repositories` change it by their lists; any other event proves the App covers its repository.
 */
export function applyCoverage(db: HubDb, event: string, payload: unknown, at: number): boolean {
  try {
    const p = (payload ?? {}) as { action?: unknown; repositories?: unknown; repositories_added?: unknown; repositories_removed?: unknown; repository?: unknown };
    if (event === "installation") {
      if (p.action === "created" || p.action === "new_permissions_accepted" || p.action === "unsuspend") return markCovered(db, repoIds(p.repositories), at);
      if (p.action === "deleted" || p.action === "suspend") return unmarkCovered(db, repoIds(p.repositories));
      return false;
    }
    if (event === "installation_repositories") {
      const added = markCovered(db, repoIds(p.repositories_added), at);
      const removed = unmarkCovered(db, repoIds(p.repositories_removed));
      return added || removed;
    }
    if (event === "ping") return false;
    return markCovered(db, repoIds([p.repository]), at);
  } catch {
    return false;
  }
}
