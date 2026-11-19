/**
 * What the AI pointed at: pull request links to make glow on whatever page shows them. Kept in the tab's sessionStorage for ten
 * minutes, so it follows you from page to page and is gone when the tab closes. Nothing here is sent anywhere.
 */
const KEY = "mp-ai-glow";
const EVENT = "mp-glow";
const TTL_MS = 10 * 60_000;

export type Glow = { hrefs: string[]; until: number };

export function readGlow(now = Date.now()): Glow | null {
  try {
    const g = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Glow | null;
    return g && Array.isArray(g.hrefs) && g.until > now && g.hrefs.length > 0 ? g : null;
  } catch {
    return null;
  }
}

function write(g: Glow | null) {
  try {
    if (g) sessionStorage.setItem(KEY, JSON.stringify(g));
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage can be blocked: the highlight simply does not persist
  }
  window.dispatchEvent(new Event(EVENT));
}

export function setGlow(hrefs: string[], now = Date.now()) {
  write({ hrefs: [...new Set(hrefs.filter((h) => h.startsWith("/")))].slice(0, 10), until: now + TTL_MS });
}

/** Stops highlighting one link (you opened it), or all of them. */
export function clearGlow(href?: string) {
  const g = readGlow();
  if (!href || !g) return write(null);
  const left = g.hrefs.filter((h) => h !== href);
  write(left.length ? { hrefs: left, until: g.until } : null);
}

export const GLOW_EVENT = EVENT;
