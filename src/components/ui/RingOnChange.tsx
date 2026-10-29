"use client";

import { useState, type ReactNode } from "react";

/**
 * Wraps a control whose icon should swing once when `value` goes UP (a new notification). The first render and decreases are
 * quiet, and the effect is only a data attribute: the animation itself is `.bell-link[data-ring]` in motion.css, so reduced
 * motion removes it with the tokens.
 */
export function RingOnChange({ value, children }: { value: number; children: (ringing: boolean) => ReactNode }) {
  const [prev, setPrev] = useState(value);
  const [bump, setBump] = useState(0);
  if (value !== prev) {
    setPrev(value);
    if (value > prev) setBump((n) => n + 1);
  }
  return <span key={bump} className="contents">{children(bump > 0)}</span>;
}
