"use client";

import { useEffect, useRef, type ReactNode } from "react";

const MAX = 14;
const clamp = (n: number) => Math.min(MAX, Math.max(-MAX, n));

/** The icon tile of an empty state. It leans toward the pointer while the pointer is over the empty state (from Flint). */
export function TiltTile({ children }: { children: ReactNode }) {
  const tile = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = tile.current;
    const host = el?.parentElement;
    if (!el || !host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / 120;
      const dy = (e.clientY - (r.top + r.height / 2)) / 120;
      el.style.transform = `perspective(260px) rotateX(${clamp(-dy * MAX)}deg) rotateY(${clamp(dx * MAX)}deg)`;
    };
    const leave = () => (el.style.transform = "");
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <span ref={tile} className="tilt-tile mb-3 inline-flex size-10 items-center justify-center rounded-full border border-line bg-canvas text-ink-3">
      {children}
    </span>
  );
}
