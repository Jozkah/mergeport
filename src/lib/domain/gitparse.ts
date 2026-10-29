/** Parsers for machine-readable git output. Shared by the server (validation) and the local connector. Pure. */

export type ParsedWorktree = {
  path: string;
  head: string | null;
  branch: string | null; // short name, null when detached or bare
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
};

/** Parse `git worktree list --porcelain -z`. Records are NUL-delimited fields; a record ends with an empty field. */
export function parseWorktreeList(out: string): ParsedWorktree[] {
  const res: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  const fields = out.split("\0");
  for (const f of fields) {
    if (f === "") {
      if (cur) res.push(cur);
      cur = null;
      continue;
    }
    const sp = f.indexOf(" ");
    const k = sp === -1 ? f : f.slice(0, sp);
    const v = sp === -1 ? "" : f.slice(sp + 1);
    if (k === "worktree") {
      if (cur) res.push(cur);
      cur = { path: v, head: null, branch: null, detached: false, bare: false, locked: false, lockedReason: null, prunable: false, prunableReason: null };
    } else if (cur) {
      if (k === "HEAD") cur.head = v || null;
      else if (k === "branch") cur.branch = v.replace(/^refs\/heads\//, "");
      else if (k === "detached") cur.detached = true;
      else if (k === "bare") cur.bare = true;
      else if (k === "locked") {
        cur.locked = true;
        cur.lockedReason = v || null;
      } else if (k === "prunable") {
        cur.prunable = true;
        cur.prunableReason = v || null;
      }
    }
  }
  if (cur) res.push(cur);
  return res;
}

export type ParsedStatus = {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Only counts are kept. File names never leave the machine. */
  dirty: boolean;
};

/** Parse `git status --porcelain=v1 -z --branch`. */
export function parseStatus(out: string): ParsedStatus {
  const s: ParsedStatus = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith("## ")) {
      const h = e.slice(3);
      if (h.startsWith("HEAD (no branch)")) s.branch = null;
      else if (h.startsWith("No commits yet on ")) s.branch = h.slice("No commits yet on ".length);
      else {
        const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
        if (m) {
          s.branch = m[1];
          s.upstream = m[2] ?? null;
          if (m[3]) {
            const a = /ahead (\d+)/.exec(m[3]);
            const b = /behind (\d+)/.exec(m[3]);
            s.ahead = a ? Number(a[1]) : 0;
            s.behind = b ? Number(b[1]) : 0;
          } else if (m[2]) {
            s.ahead = 0;
            s.behind = 0;
          }
        }
      }
      continue;
    }
    const x = e[0];
    const y = e[1];
    if (x === "?" && y === "?") {
      s.untracked++;
      continue;
    }
    if (x === "R" || x === "C") i++; // renames/copies carry the original path as a following field
    const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflict) {
      s.conflicted++;
      continue;
    }
    if (x !== " " && x !== "!") s.staged++;
    if (y !== " " && y !== "!") s.unstaged++;
  }
  s.dirty = s.staged + s.unstaged + s.untracked + s.conflicted > 0;
  return s;
}
