/** Display helpers. Instants are stored UTC and shown in the viewer's timezone; milestone/due dates are date-only. */

export function formatInstant(d: Date | null | undefined, tz: string): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Date-only values (due dates, milestone targets) carry no time or zone: always read them as UTC calendar dates. */
export function formatDateOnly(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`.replace(/ 0m$/, "");
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`.replace(/ 0h$/, "");
}

export function relativeTime(d: Date, now: Date): string {
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return "just now";
  return `${formatDuration(diff)} ago`;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
