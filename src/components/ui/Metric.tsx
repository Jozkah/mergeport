"use client";

import { useState, type ReactNode } from "react";

// When the person last pressed, tapped or typed in this tab. A number that changes right after that is the answer to their own
// action; one that changes with no input just before it arrived through a background refresh, and house rule 6 (PRODUCT.md) says
// those never animate.
let lastInput = 0;
if (typeof window !== "undefined") {
  const mark = () => {
    lastInput = Date.now();
  };
  for (const e of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(e, mark, { capture: true, passive: true });
}
const OWN_ACTION_MS = 3000;
const ownAction = () => Date.now() - lastInput < OWN_ACTION_MS;

/**
 * A number that moves ONLY when its value actually changes AND the change follows something the person just did. The first render
 * is static (no entrance on navigation), an unchanged poll renders nothing new, and a value that changes through a background
 * refresh (the auto-refresh timer, live updates, another tab) is swapped without animation. When it does animate, the digits
 * re-enter with a short blurred slide (`.num-in`); reduced motion turns that into a plain fade.
 * The label is the real value at all times, so screen readers and copy/paste see no animation.
 */
export function Metric({ value, format, className }: { value: number | string; format?: (v: number | string) => ReactNode; className?: string }) {
  const [prev, setPrev] = useState(value);
  const [bump, setBump] = useState(0);
  // Adjusting state while rendering is React's documented alternative to an effect for "value changed" detection.
  if (!Object.is(prev, value)) {
    setPrev(value);
    if (ownAction()) setBump((n) => n + 1);
  }
  return (
    <span key={bump} className={`tnum ${bump > 0 ? "num-in" : ""} ${className ?? ""}`}>
      {format ? format(value) : value}
    </span>
  );
}
