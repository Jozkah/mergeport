"use client";

import * as T from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Tooltip for icon-only controls and status chips. It supplements an accessible name; it never replaces one.
 * Opens after a short intent delay (80 ms, so a passing pointer does not trigger it), appears with a small scale + rise
 * (`.tip` in motion.css), and closes faster than it opened. Moving between neighbouring triggers skips the delay, and the
 * next tooltip then glides from the previous one's box to its own, with its text sliding in from the side (ported from Flint).
 * Keyboard focus opens it too; Escape closes it. Under reduced motion it only fades.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={80} skipDelayDuration={300}>
      {children}
    </T.Provider>
  );
}

const WARM_WINDOW = 300;
const GLIDE_MS = 320;
const GLIDE_EASE = "cubic-bezier(0.34, 1.3, 0.5, 1)";
const TEXT_SHIFT = 10;
// The last visible tooltip box, to glide from.
let lastRect: { rect: DOMRect; at: number } | null = null;
let live = 0;

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function TipContent({ side, children }: { side: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  const el = useRef<HTMLDivElement | null>(null);
  const text = useRef<HTMLSpanElement>(null);
  const glide = useRef(false);
  const setEl = useCallback((n: HTMLDivElement | null) => {
    el.current = n;
  }, []);

  // Decide before paint whether this tooltip glides, so the pop is skipped.
  useLayoutEffect(() => {
    const warm = !reduced() && lastRect !== null && (live > 0 || performance.now() - lastRect.at < WARM_WINDOW);
    glide.current = warm;
    if (warm) el.current?.setAttribute("data-glide", "");
    live += 1;
    return () => {
      live -= 1;
      if (lastRect) lastRect.at = performance.now();
    };
  }, []);

  // Once Radix has placed the box, remember it and glide in from the last one.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const run = () => {
      const node = el.current;
      if (!node) return;
      const wrapper = node.parentElement;
      // Radix parks the wrapper off screen until it is measured.
      if (wrapper && /-200%/.test(wrapper.style.transform) && tries++ < 8) {
        frame = requestAnimationFrame(run);
        return;
      }
      const next = node.getBoundingClientRect();
      const prev = lastRect?.rect;
      if (glide.current && prev && typeof node.animate === "function") {
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        const sx = next.width ? prev.width / next.width : 1;
        const sy = next.height ? prev.height / next.height : 1;
        node.animate([{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: "0 0", transform: "none" }], { duration: GLIDE_MS, easing: GLIDE_EASE });
        const dir = Math.sign(next.left + next.width / 2 - (prev.left + prev.width / 2)) || 1;
        text.current?.animate([{ opacity: 0, transform: `translateX(${TEXT_SHIFT * dir}px)`, filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      }
      lastRect = { rect: next, at: performance.now() };
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <T.Content ref={setEl} side={side} sideOffset={6} className="tip z-[60] max-w-[260px] rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-snug text-ink shadow-pop">
      <span ref={text} className="block">{children}</span>
    </T.Content>
  );
}

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <TipContent side={side}>{label}</TipContent>
      </T.Portal>
    </T.Root>
  );
}
