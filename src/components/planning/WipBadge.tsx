import { wipState } from "@/lib/domain/boards";

/** "3/4": the column's count against its limit. Over the limit is flagged in words as well as colour. It is advice only; nothing is blocked. */
export function WipBadge({ count, limit }: { count: number; limit: number }) {
  const s = wipState(count, limit);
  const cls = s === "over" ? "border-blocked text-blocked" : s === "at" ? "border-waiting text-waiting" : "border-line text-ink-3";
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 text-[11px] leading-5 tnum ${cls}`} title={s === "over" ? `Over the limit of ${limit}` : `Limit ${limit}`}>
      <span className="sr-only">Work in progress limit: </span>
      {count}/{limit}
      {s === "over" && <span className="ml-1">over</span>}
    </span>
  );
}
