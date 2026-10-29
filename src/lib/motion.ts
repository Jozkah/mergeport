"use client";

import { useSyncExternalStore } from "react";

/**
 * The JavaScript side of the motion tokens in src/app/motion.css. GSAP and JS timers read the SAME values CSS uses, so a
 * change in the stylesheet changes every interaction, and reduced motion (which collapses the distance/scale tokens and
 * shortens the durations) reaches them too.
 */

const REDUCE = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCE).matches;
}

/** True when the person asked for reduced motion; updates live when the OS setting changes. Server snapshot is false. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(REDUCE);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}

/** A token as a number: "--duration-fast" -> 0.25 (seconds), "--distance-base" -> 8 (px), "--scale-large" -> 0.96. */
export function token(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return raw.endsWith("ms") ? n / 1000 : n;
}

/** Seconds, for GSAP. */
export const seconds = (name: string, fallback: number) => token(name, fallback);

/** Milliseconds, for timers. */
export const millis = (name: string, fallbackMs: number) => Math.round(token(name, fallbackMs / 1000) * 1000);

/** The smooth-out curve as a GSAP-compatible CustomEase-free ease (power3.out is the closest built-in match to cubic-bezier(.22,1,.36,1)). */
export const SMOOTH_OUT_GSAP = "power3.out";
