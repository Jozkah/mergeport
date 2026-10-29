"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

type Item = { href: string; label: string; active: boolean; count?: number };

/**
 * Segmented link group with a sliding active pill (CSS transform + width, see .seg-ind). The pill is positioned by
 * measuring the active link. The first placement and any resize are written without a transition so the pill never
 * sweeps in from the corner; only a change of the active item slides.
 */
export function Segmented({ items, label }: { items: Item[]; label: string }) {
  const nav = useRef<HTMLElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const activeIndex = items.findIndex((i) => i.active);

  const place = useCallback((animate: boolean) => {
    const root = nav.current;
    const pill = ind.current;
    if (!root || !pill) return;
    const cur = root.querySelector<HTMLElement>('[aria-current="true"]');
    if (!cur) {
      root.removeAttribute("data-slide");
      return;
    }
    if (!animate) pill.style.transition = "none";
    pill.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`;
    pill.style.width = `${cur.offsetWidth}px`;
    pill.style.height = `${cur.offsetHeight}px`;
    if (!animate) {
      void pill.offsetWidth; // commit the un-animated position before transitions come back
      pill.style.transition = "";
    }
    root.setAttribute("data-slide", "ready");
  }, []);

  useLayoutEffect(() => {
    place(placed.current);
    placed.current = true;
  }, [activeIndex, items.length, place]);

  useEffect(() => {
    const root = nav.current;
    if (!root) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false; // the initial callback is not a resize
        return;
      }
      place(false);
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [place]);

  return (
    <nav ref={nav} className="seg" aria-label={label}>
      <span ref={ind} className="seg-ind" aria-hidden />
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={i.active ? "true" : undefined} scroll={false}>
          {i.label}
          {i.count !== undefined && <span className="tnum opacity-70">{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
