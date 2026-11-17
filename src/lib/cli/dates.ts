import { UsageError } from "./argv";

const DAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

/** Today's calendar date (YYYY-MM-DD) in the viewer's time zone; falls back to UTC for an unknown zone. */
export function todayIn(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Reads a due date: YYYY-MM-DD, today, tomorrow, or a weekday name (mon, friday, ...). A weekday means the next one after today,
 * so "friday" said on a Friday is a week away. "none" clears the date (returns null).
 */
export function parseDue(raw: string, now: Date, timeZone: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === "none") return null;
  const today = todayIn(now, timeZone);
  if (v === "today") return today;
  if (v === "tomorrow") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(v + "T00:00:00Z");
    if (!Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v) return v;
    throw new UsageError(`"${raw}" is not a real date`);
  }
  if (v in DAYS) {
    const dow = new Date(Date.parse(today + "T00:00:00Z")).getUTCDay();
    return addDays(today, ((DAYS[v] - dow + 6) % 7) + 1);
  }
  throw new UsageError(`Due must be YYYY-MM-DD, today, tomorrow, a weekday like fri, or none (got "${raw}")`);
}
