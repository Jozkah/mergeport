"use client";

import { useEffect, useRef, useState } from "react";

export type StatusMarkState = "pending" | "running" | "done" | "failed" | "cancelled";

/**
 * A step's status as one ring that morphs: a dashed ring while it waits, a spinning arc (or a filled arc for a known
 * progress) while it runs, then a solid ring that draws a check or a cross. Ported from Flint's status mark, without a motion
 * library. The state is also always available as text through `label`/`ariaLabel`; colour and motion only reinforce it.
 */

const STROKE = 2;
const DASHES = 8;
const SPIN_MS = 1100;
const ARC = 0.68;
const IDLE = 0.3;
const R = 12 - STROKE / 2 - 1;
const CIRC = 2 * Math.PI * R;
const PERIOD = CIRC / DASHES;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const dash = (mode: number, arc: number) => {
  const d = IDLE * PERIOD + (arc * CIRC - IDLE * PERIOD) * mode;
  const g = (1 - IDLE) * PERIOD + ((1 - arc) * CIRC - (1 - IDLE) * PERIOD) * mode;
  return `${Math.max(0, d)} ${Math.max(0, g)}`;
};
const target = (status: StatusMarkState, progress?: number) => {
  const solid = status === "running" || status === "done" || status === "failed";
  const determinate = status === "running" && typeof progress === "number";
  const indeterminate = status === "running" && !determinate;
  return { solid, indeterminate, arc: indeterminate ? ARC : determinate ? clamp01(progress ?? 0) : 1 };
};

/** Tween one number; returns a stop function. */
function tween(from: number, to: number, ms: number, ease: (t: number) => number, onUpdate: (v: number) => void, onDone?: () => void) {
  const t0 = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    onUpdate(from + (to - from) * ease(k));
    if (k < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

const reducedNow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function StatusMark({ status, progress, size = 16, ariaLabel, className = "" }: { status: StatusMarkState; progress?: number; size?: number; ariaLabel?: string; className?: string }) {
  const ring = useRef<SVGCircleElement>(null);
  const geo = useRef({ mode: 0, arc: 1, travel: 0 });
  const [initial] = useState(() => {
    const t = target(status, progress);
    return dash(t.solid ? 1 : 0, t.arc);
  });

  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    const g = geo.current;
    const t = target(status, progress);
    const writeDash = () => el.setAttribute("stroke-dasharray", dash(g.mode, g.arc));
    const writeOff = () => el.setAttribute("stroke-dashoffset", String(g.travel));
    if (reducedNow()) {
      g.mode = t.solid ? 1 : 0;
      g.arc = t.arc;
      g.travel = 0;
      writeDash();
      writeOff();
      return;
    }
    const stops: (() => void)[] = [];
    let raf = 0;
    if (g.mode === 0) g.arc = t.arc;
    stops.push(tween(g.mode, t.solid ? 1 : 0, 300, easeInOut, (v) => { g.mode = v; writeDash(); }));
    stops.push(tween(g.arc, t.arc, 300, easeOut, (v) => { g.arc = v; writeDash(); }));
    if (t.indeterminate) {
      let last = performance.now();
      const step = (now: number) => {
        g.travel -= (CIRC * (now - last)) / SPIN_MS;
        last = now;
        writeOff();
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    } else {
      const unit = typeof progress === "number" && status === "running" ? CIRC : PERIOD;
      const to = Math.floor(g.travel / unit) * unit;
      stops.push(tween(g.travel, to, 300, easeOut, (v) => { g.travel = v; writeOff(); }, () => { g.travel = 0; writeOff(); }));
    }
    return () => {
      cancelAnimationFrame(raf);
      stops.forEach((s) => s());
    };
  }, [status, progress]);

  const crossed = status === "failed" || status === "cancelled";
  const tone = status === "done" ? "text-ok" : status === "failed" ? "text-blocked" : status === "running" ? "text-waiting" : "text-ink-3";
  const drawn = (on: boolean) => `fill-none stroke-current [stroke-dasharray:1_2] motion-safe:transition-[stroke-dashoffset,opacity] motion-safe:duration-200 ${on ? "[stroke-dashoffset:0] opacity-100" : "[stroke-dashoffset:1.05] opacity-0"}`;

  return (
    <svg
      data-status={status}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={`shrink-0 overflow-visible motion-safe:transition-colors motion-safe:duration-200 ${tone} ${className}`}
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={12} cy={12} r={R} stroke="none" className={`fill-current motion-safe:transition-opacity motion-safe:duration-200 ${status === "done" || status === "failed" ? "opacity-[0.08]" : "opacity-0"}`} />
      <circle ref={ring} cx={12} cy={12} r={R} transform="rotate(-90 12 12)" fill="none" stroke="currentColor" strokeDasharray={initial} strokeDashoffset={0} className={`motion-safe:transition-opacity motion-safe:duration-200 ${status === "pending" ? "opacity-55" : "opacity-100"}`} />
      <path d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1} className={drawn(status === "done")} />
      <path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength={1} className={drawn(crossed)} />
    </svg>
  );
}
