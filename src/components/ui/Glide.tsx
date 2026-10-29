"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * A highlight that glides from one menu entry to the next instead of each entry flashing on its own (ported from Flint's model
 * picker). Put <Glide for={listRef} /> inside a positioned list; entries are anything with role="menuitem" or "option". It follows the
 * pointer and keyboard focus, lands in place the first time it appears, and is a plain fade under reduced motion.
 */
export function Glide({ for: container }: { for: RefObject<HTMLElement | null> }) {
  const [box, setBox] = useState<{ y: number; h: number; jump: boolean } | null>(null);
  const shown = useRef(false);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const place = (e: Event) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>('[role="menuitem"],[role="option"]');
      if (!el || !root.contains(el) || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      const y = el.offsetTop;
      const h = el.offsetHeight;
      setBox((b) => (b && b.y === y && b.h === h ? b : { y, h, jump: !shown.current }));
      shown.current = true;
    };
    const leave = () => {
      if (!root.contains(document.activeElement)) {
        setBox(null);
        shown.current = false;
      }
    };
    root.addEventListener("pointerover", place);
    root.addEventListener("focusin", place);
    root.addEventListener("pointerleave", leave);
    return () => {
      root.removeEventListener("pointerover", place);
      root.removeEventListener("focusin", place);
      root.removeEventListener("pointerleave", leave);
    };
  }, [container]);

  return <span aria-hidden className="glide-pill" data-visible={box ? "" : undefined} data-jump={box?.jump ? "" : undefined} style={{ transform: `translateY(${box?.y ?? 0}px)`, height: box?.h ?? 0 }} />;
}
