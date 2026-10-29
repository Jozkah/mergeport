"use client";

import { useState, type ReactNode } from "react";

/**
 * A number that moves ONLY when its value actually changes. The first render is static (no entrance on navigation or on a
 * refresh that brings the same value), and a poll that returns an unchanged value re-renders nothing visible. When the value
 * does change, the digits re-enter with a short blurred slide (`.num-in`); reduced motion turns that into a plain fade.
 * The label is the real value at all times, so screen readers and copy/paste see no animation.
 */
export function Metric({ value, format, className }: { value: number | string; format?: (v: number | string) => ReactNode; className?: string }) {
  const [prev, setPrev] = useState(value);
  const [bump, setBump] = useState(0);
  // Adjusting state while rendering is React's documented alternative to an effect for "value changed" detection.
  if (!Object.is(prev, value)) {
    setPrev(value);
    setBump((n) => n + 1);
  }
  return (
    <span key={bump} className={`tnum ${bump > 0 ? "num-in" : ""} ${className ?? ""}`}>
      {format ? format(value) : value}
    </span>
  );
}
