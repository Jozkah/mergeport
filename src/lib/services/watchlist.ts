import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { ValidationError } from "@/lib/errors";
import type { GithubPort } from "@/lib/github/port";
import { enqueue } from "@/lib/jobs";
import { audit } from "./audit";
import { trackLocally, type RepoMeta } from "./repositories";

/**
 * A watchlist is a pasted list of repositories to follow. One address on a line tracks it (and, when GitHub says it is a fork,
 * its parent, mapped as the upstream). Two addresses on a line, "fork upstream", map them even when GitHub does not call
 * the first a fork (a detached copy, a mirror, a fork into another network). Nothing is shared with teammates.
 */

export const WATCHLIST_MAX_LINES = 40;

export type Ref = { owner: string; name: string };
export type WatchLine = { raw: string; refs: Ref[]; error?: string };

const ADDRESS = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob|pull|pulls|issues|commits?|actions|releases)(?:\/.*)?)?\/?$/;

export function parseRef(token: string): Ref | null {
  const m = ADDRESS.exec(token.trim().replace(/[<>(),;]+$/g, ""));
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Lines are separated by new lines. Inside a line the addresses are separated by spaces, commas, "->", "=>" or "→". */
export function parseWatchlist(text: string): WatchLine[] {
  const seen = new Set<string>();
  const out: WatchLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s*(?:->|=>|→)\s*|[\s,]+/).filter(Boolean);
    const refs: Ref[] = [];
    let bad: string | null = null;
    for (const t of tokens) {
      const r = parseRef(t);
      if (!r) bad = t;
      else refs.push(r);
    }
    const key = refs.map((r) => `${r.owner}/${r.name}`.toLowerCase()).join(">");
    if (bad) out.push({ raw: line, refs: [], error: `“${bad}” is not a GitHub address` });
    else if (refs.length > 2) out.push({ raw: line, refs: [], error: "Put at most two addresses on a line: the fork, then its upstream" });
    else if (!seen.has(key)) {
      seen.add(key);
      out.push({ raw: line, refs });
    }
  }
  return out;
}

export type WatchResult = { raw: string; ok: boolean; notes: string[]; error?: string };

export async function applyWatchlist(db: Db, v: Viewer, port: GithubPort, text: string): Promise<WatchResult[]> {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can map forks");
  const lines = parseWatchlist(text);
  if (lines.length === 0) throw new ValidationError("Paste at least one repository address");
  if (lines.length > WATCHLIST_MAX_LINES) throw new ValidationError(`At most ${WATCHLIST_MAX_LINES} lines at a time`);

  type Resolved = { meta: RepoMeta; row: { id: string; defaultBranch: string | null } };
  const cache = new Map<string, Resolved>();
  async function resolve(r: Ref): Promise<Resolved> {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const meta = await port.getRepository(r.owner, r.name);
    const [row] = await trackLocally(db, v, [meta]);
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: row.id, full: true }, dedupeKey: `sync:${row.id}` });
    const res = { meta, row };
    cache.set(key, res);
    return res;
  }

  async function map(fork: { row: { id: string; defaultBranch: string | null } }, up: { row: { id: string; defaultBranch: string | null } }) {
    if (fork.row.id === up.row.id) throw new ValidationError("A repository cannot be its own upstream");
    const forkBranch = fork.row.defaultBranch || "main";
    const upstreamBranch = up.row.defaultBranch || "main";
    const m = await db.forkMapping.upsert({
      where: { forkRepoId_upstreamRepoId_forkBranch_upstreamBranch: { forkRepoId: fork.row.id, upstreamRepoId: up.row.id, forkBranch, upstreamBranch } },
      create: { forkRepoId: fork.row.id, upstreamRepoId: up.row.id, forkBranch, upstreamBranch },
      update: {},
    });
    await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
    return m;
  }

  const results: WatchResult[] = [];
  for (const line of lines) {
    if (line.error) {
      results.push({ raw: line.raw, ok: false, notes: [], error: line.error });
      continue;
    }
    try {
      const notes: string[] = [];
      if (line.refs.length === 2) {
        const [a, b] = [await resolve(line.refs[0]), await resolve(line.refs[1])];
        await map(a, b);
        notes.push(`${a.meta.fullName} is compared with ${b.meta.fullName}`);
      } else {
        const a = await resolve(line.refs[0]);
        if (a.meta.isFork && a.meta.parentFullName) {
          const [owner, name] = a.meta.parentFullName.split("/");
          const parent = await resolve({ owner, name });
          await map(a, parent);
          notes.push(`${a.meta.fullName} is a fork of ${parent.meta.fullName}: compared`);
        } else {
          notes.push(`${a.meta.fullName} is tracked. GitHub does not list it as a fork, so to compare it write “fork upstream” on one line`);
        }
      }
      results.push({ raw: line.raw, ok: true, notes });
    } catch (e) {
      const nf = typeof e === "object" && e !== null && (e as { kind?: string }).kind === "not-found";
      results.push({ raw: line.raw, ok: false, notes: [], error: nf ? "Not found with your GitHub access (check the address, or sign in as an account that can read it)" : e instanceof Error ? e.message : "Could not be added" });
    }
  }
  await audit(db, v, "watchlist.apply", undefined, { lines: lines.length, ok: results.filter((r) => r.ok).length });
  return results;
}
