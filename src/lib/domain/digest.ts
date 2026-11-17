import { todayIn } from "./planning";

/**
 * Calendar and schedule rules of the daily digest. Pure: no I/O, no clock (callers pass `now`).
 * A "day" is a local calendar date (YYYY-MM-DD) in the person's time zone. The digest generated on day D reports day D-1.
 */

export const DIGEST_DEFAULT_HOUR = 8;
export const DIGEST_STALE_REQUEST_DAYS = 2;

export type DigestSettings = { enabled: boolean; hour: number };
export const DEFAULT_DIGEST_SETTINGS: DigestSettings = { enabled: true, hour: DIGEST_DEFAULT_HOUR };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Reads settings of any shape; anything unusable falls back field by field. */
export function parseDigestSettings(raw: unknown): DigestSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as { enabled?: unknown; hour?: unknown };
  const hour = typeof r.hour === "number" && Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23 ? r.hour : DIGEST_DEFAULT_HOUR;
  return { enabled: typeof r.enabled === "boolean" ? r.enabled : true, hour };
}

/** The calendar date `delta` days from `day`, by calendar arithmetic (never by adding 24 hours, which breaks on a DST change). */
export function shiftDay(day: string, delta: number): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Not a calendar date: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta)).toISOString().slice(0, 10);
}

export const isDay = (s: unknown): s is string => typeof s === "string" && DAY.test(s) && shiftDay(s, 0) === s;

/** Offset of `tz` from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(at: number, tz: string): number {
  const whole = at - (((at % 1000) + 1000) % 1000);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(whole));
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - whole;
}

/** The instant a local calendar day starts in `tz`. Correct across daylight-saving changes; an unknown zone counts as UTC. */
export function dayStart(day: string, tz: string): Date {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Not a calendar date: ${day}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    let guess = wall - offsetMs(wall, tz);
    const again = offsetMs(guess, tz); // the offset can differ at the instant itself when a change falls between the guess and midnight
    if (again !== wall - guess) guess = wall - again;
    return new Date(guess);
  } catch {
    return new Date(wall);
  }
}

/** The local day before the one `now` falls on, with its exact [start, end) window as instants. */
export function reportedDay(now: Date, tz: string): { day: string; today: string; start: Date; end: Date } {
  const today = todayIn(tz, now);
  const day = shiftDay(today, -1);
  return { day, today, start: dayStart(day, tz), end: dayStart(today, tz) };
}

/** Local clock hour (0-23) in `tz`. */
export function localHour(now: Date, tz: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find((p) => p.type === "hour")!.value);
  } catch {
    return now.getUTCHours();
  }
}

/** Whole days between two instants, never negative. */
export const ageDays = (since: Date | null, now: Date): number | null => (since ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000)) : null);

/**
 * Is a digest due right now? Once the configured hour has passed on the local day, and none exists yet for the reported day.
 * Opening the app later in the day counts as "hour has passed": that is the catch-up.
 */
export function digestDue(o: { now: Date; tz: string; settings: DigestSettings; haveDay: boolean }): boolean {
  return o.settings.enabled && !o.haveDay && localHour(o.now, o.tz) >= o.settings.hour;
}
