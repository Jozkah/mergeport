"use client";

import { useEffect } from "react";

/** Tells every `.spot-card` where the pointer is over it (as --mx and --my), so its CSS light can follow. One listener for the page. */
export function SpotlightProvider() {
  useEffect(() => {
    let raf = 0;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const card = (e.target as Element | null)?.closest<HTMLElement>(".spot-card");
      if (!card) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => {
      document.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
