/**
 * Three-way merge of one entity's data. Pure.
 *
 *  base   = what both sides last agreed on
 *  local  = this machine's current value
 *  remote = the value now in the coordination repository
 *
 * Per top-level key: if only one side changed it, take that side; if both changed it to the same value, fine; if both
 * changed it differently, that key CONFLICTS. Keys listed in `setKeys` hold sets (arrays of strings) and merge by
 * adds/removes instead of conflicting. A conflict never discards either value: both are kept for a person to resolve.
 */

export type Data = Record<string, unknown>;
export type MergeResult = { merged: Data; conflicts: string[] };

export function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + stable((v as Data)[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

export function threeWayMerge(base: Data | null, local: Data, remote: Data, setKeys: string[] = []): MergeResult {
  const b = base ?? {};
  const merged: Data = {};
  const conflicts: string[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(local), ...Object.keys(remote)])) {
    const bv = b[k], lv = local[k], rv = remote[k];
    if (setKeys.includes(k)) {
      const bs = new Set((bv as string[] | undefined) ?? []);
      const ls = new Set((lv as string[] | undefined) ?? []);
      const rs = new Set((rv as string[] | undefined) ?? []);
      const out = new Set<string>();
      for (const x of new Set([...bs, ...ls, ...rs])) {
        const inB = bs.has(x), inL = ls.has(x), inR = rs.has(x);
        // removed by either side (relative to base) wins over "unchanged" on the other; added by either side wins
        const lAdd = inL && !inB, rAdd = inR && !inB, lDel = inB && !inL, rDel = inB && !inR;
        if (lAdd || rAdd || (inB && !lDel && !rDel)) out.add(x);
      }
      merged[k] = [...out].sort();
      continue;
    }
    if (same(lv, rv)) merged[k] = lv;
    else if (same(lv, bv)) merged[k] = rv;
    else if (same(rv, bv)) merged[k] = lv;
    else {
      conflicts.push(k);
      merged[k] = rv; // placeholder; the conflict record keeps both values
    }
  }
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return { merged, conflicts };
}
