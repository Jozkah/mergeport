"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "@/components/ui/icons";
import { THEMES, THEME_EVENT, parseTheme, themeAttribute, themeCookie, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/util";
import { Tip } from "@/components/ui/Tooltip";

const LABEL: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** The server rendered <html data-theme> from the cookie; the DOM attribute is the single source of truth on the client. */
function read(): ThemePreference {
  return parseTheme(document.documentElement.getAttribute("data-theme"));
}
function subscribe(fn: () => void) {
  window.addEventListener(THEME_EVENT, fn);
  return () => window.removeEventListener(THEME_EVENT, fn);
}

let generation = 0;

function apply(pref: ThemePreference) {
  const root = document.documentElement;
  const swap = () => {
    const attr = themeAttribute(pref);
    if (attr) root.setAttribute("data-theme", attr);
    else root.removeAttribute("data-theme");
    document.cookie = themeCookie(pref);
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  // Elements must not each tween their own colours at once (that reads as a smear). Where the browser can snapshot the page,
  // the whole page cross-fades once, quickly (View Transitions; see ::view-transition-* in motion.css). Anywhere else the swap
  // is instant. Either way nothing waits on it: the new theme is already in place when the callback returns.
  root.classList.add("theme-switching");
  // Only the newest switch may end the suppression: a superseded one finishing early would re-enable colour transitions
  // (and the header blur) while the newer swap is still being painted.
  const mine = ++generation;
  const done = () => {
    if (mine === generation) root.classList.remove("theme-switching");
  };
  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void>; skipTransition: () => void } }).startViewTransition;
  if (typeof vt === "function") {
    const t = vt.call(document, swap);
    // The switch must never wait on the animation: if the snapshot is not ready quickly, show the new theme now.
    const guard = setTimeout(() => t.skipTransition(), 400);
    const end = () => {
      clearTimeout(guard);
      done();
    };
    t.finished.then(end, end);
    setTimeout(done, 1500); // belt and braces: transitions are never left switched off
  } else {
    swap();
    requestAnimationFrame(() => requestAnimationFrame(done));
  }
}

function useTheme(initial: ThemePreference) {
  const pref = useSyncExternalStore(subscribe, read, () => initial);
  return [pref, useCallback((p: ThemePreference) => apply(p), [])] as const;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
/** What "System" resolves to right now. The server snapshot is false; React re-renders with the real value after hydration. */
function useSystemDark() {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(DARK_QUERY);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

/** Quick toggle for the shell. Flips between the two concrete themes; "System" is chosen in Settings. */
export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [pref, set] = useTheme(initial);
  const systemDark = useSystemDark();
  const isDark = pref === "dark" || (pref === "system" && systemDark);
  return (
    <Tip label={`Theme: ${LABEL[pref]}. Switch to ${isDark ? "light" : "dark"}.`}>
      <button type="button" className="btn btn-quiet btn-icon theme-toggle" aria-label="Dark mode" aria-pressed={isDark} onClick={() => set(isDark ? "light" : "dark")}>
        <Sun size={16} aria-hidden className="theme-icon theme-icon-sun" />
        <Moon size={16} aria-hidden className="theme-icon theme-icon-moon" />
      </button>
    </Tip>
  );
}

/** Light / Dark / System radio group for Settings. */
export function ThemeSelect({ initial }: { initial: ThemePreference }) {
  const [pref, set] = useTheme(initial);
  return (
    <fieldset className="min-w-0">
      <legend className="label">Theme</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => {
          const I = ICON[t];
          return (
            <label key={t} className={cn("btn cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2", pref === t && "bg-ink text-ink-invert hover:bg-ink")}>
              <input type="radio" name="theme" value={t} checked={pref === t} onChange={() => set(t)} className="sr-only" />
              <I size={14} aria-hidden />
              {LABEL[t]}
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-[12px] text-ink-3">Stored on this device only. System follows your operating system and updates when it changes.</p>
    </fieldset>
  );
}
