import { Metric } from "@/components/ui/Metric";

/**
 * Bars follow the reference's bar shape (8/8/4/4 radius, pale ghost fill, dark for today).
 * Data is synchronized history only: items grouped by creation day. No trend percentage is invented.
 */
export function OpenedChart({ days, today }: { days: { date: string; count: number }[]; today: string }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <p className="py-8 text-center text-[13px] text-ink-3">No items were opened in this period in the repositories you can see.</p>;
  return (
    <figure>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`Items opened per day over the last ${days.length} days: ${days.map((d) => `${d.date} ${d.count}`).join(", ")}`}>
        {days.map((d) => (
          <div key={d.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${d.date}: ${d.count}`}>
            <span className="text-[10.5px] text-ink-3">{d.count ? <Metric value={d.count} /> : ""}</span>
            <div className={`bar-h w-full max-w-9 ${d.date === today ? "bar-on" : "bar-ghost"}`} style={{ height: `${Math.max(d.count ? 8 : 3, (d.count / max) * 100)}%`, borderRadius: "8px 8px 4px 4px", }} />
          </div>
        ))}
      </div>
      <figcaption className="mt-2 flex justify-between text-[11.5px] text-ink-3"><span>{days[0].date.slice(5)}</span><span><Metric value={total} /> opened</span><span>{days[days.length - 1].date.slice(5)}</span></figcaption>
    </figure>
  );
}
