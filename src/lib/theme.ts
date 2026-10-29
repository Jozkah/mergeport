/**
 * Theme preference. Stored per device in a first-party cookie (never synced to the team, never sent to GitHub). The
 * server reads the cookie and renders <html data-theme> directly, so the first paint already has the right palette:
 * no flash, no hydration mismatch. "system" renders no attribute; the stylesheet then follows prefers-color-scheme.
 */
export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];

export const THEME_COOKIE = "mp-theme";
export const THEME_EVENT = "mp:theme";

export function parseTheme(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** The data-theme attribute value for a preference (undefined for "system"). */
export function themeAttribute(pref: ThemePreference): "light" | "dark" | undefined {
  return pref === "system" ? undefined : pref;
}

export function themeCookie(pref: ThemePreference): string {
  const oneYear = 60 * 60 * 24 * 365;
  return `${THEME_COOKIE}=${pref}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
}
