/**
 * Personal notification preferences. Pure.
 * Each kind of event has two independent channels: the in-app list, and a desktop pop-up. Desktop pop-ups can only appear while
 * Mergeport is open in a browser on this computer (there is no server to send them otherwise), and quiet hours hold them back.
 */
export const KINDS = [
  { key: "review-requested", label: "Someone asked you to review a pull request" },
  { key: "changes-requested", label: "A reviewer asked for changes on your pull request" },
] as const;
export type NotifyKind = (typeof KINDS)[number]["key"];

export type Prefs = {
  kinds: Record<NotifyKind, { inApp: boolean; desktop: boolean }>;
  quiet: { enabled: boolean; start: string; end: string };
};

export const DEFAULT_PREFS: Prefs = {
  kinds: { "review-requested": { inApp: true, desktop: false }, "changes-requested": { inApp: true, desktop: false } },
  quiet: { enabled: false, start: "22:00", end: "07:00" },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Anything unreadable falls back to the defaults field by field; unknown keys are dropped. */
export function parsePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  const kinds = { ...DEFAULT_PREFS.kinds } as Prefs["kinds"];
  for (const k of KINDS) {
    const v = (r.kinds as Record<string, { inApp?: unknown; desktop?: unknown }> | undefined)?.[k.key];
    kinds[k.key] = { inApp: typeof v?.inApp === "boolean" ? v.inApp : DEFAULT_PREFS.kinds[k.key].inApp, desktop: typeof v?.desktop === "boolean" ? v.desktop : DEFAULT_PREFS.kinds[k.key].desktop };
  }
  const q = r.quiet;
  return { kinds, quiet: { enabled: typeof q?.enabled === "boolean" ? q.enabled : false, start: typeof q?.start === "string" && HHMM.test(q.start) ? q.start : DEFAULT_PREFS.quiet.start, end: typeof q?.end === "string" && HHMM.test(q.end) ? q.end : DEFAULT_PREFS.quiet.end } };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** The local clock time in an IANA zone, as minutes after midnight. */
export function localMinutes(now: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** Quiet hours may wrap midnight (22:00 to 07:00). Start equal to end means no quiet period. */
export function isQuiet(p: Prefs, now: Date, tz: string): boolean {
  if (!p.quiet.enabled) return false;
  const s = minutes(p.quiet.start);
  const e = minutes(p.quiet.end);
  if (s === e) return false;
  const t = localMinutes(now, tz);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export function wantsInApp(p: Prefs, kind: string): boolean {
  return (p.kinds as Record<string, { inApp: boolean }>)[kind]?.inApp ?? true;
}
/** Desktop pop-ups are opt-in per kind and held back during quiet hours. */
export function wantsDesktop(p: Prefs, kind: string, now: Date, tz: string): boolean {
  return ((p.kinds as Record<string, { desktop: boolean }>)[kind]?.desktop ?? false) && !isQuiet(p, now, tz);
}
