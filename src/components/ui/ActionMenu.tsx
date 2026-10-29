"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "@/components/ui/icons";

export type MenuItem = { label: string; onSelect?: () => void; href?: string; external?: boolean; danger?: boolean; disabled?: boolean } | "sep";

/**
 * A small "more actions" menu for a row. It opens beside its button, outside any scrolling table so it is never clipped, closes on
 * Escape, outside click or scroll, and works with the arrow keys.
 */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; ready: boolean } | null>(null);
  const close = useCallback(() => {
    setAt(null);
    btn.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!at || at.ready || !btn.current || !pop.current) return;
    const b = btn.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(b.right - p.width, window.innerWidth - p.width - 8));
    const below = b.bottom + 4 + p.height <= window.innerHeight - 8;
    setAt({ x, y: below ? b.bottom + 4 : Math.max(8, b.top - p.height - 4), ready: true });
    pop.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => {
      if (e.target instanceof Node && (pop.current?.contains(e.target) || btn.current?.contains(e.target))) return;
      setAt(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    const off = () => setAt(null);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", off, true);
    window.addEventListener("resize", off);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("resize", off);
    };
  }, [at, close]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Tab") setAt(null);
    else return;
    e.preventDefault();
  };

  const cls = (danger?: boolean) => `flex min-h-8 w-full items-center rounded-[6px] px-2 py-1.5 text-left text-[13px] outline-none enabled:hover:bg-hover enabled:focus-visible:bg-hover aria-disabled:opacity-40 ${danger ? "text-blocked" : "text-ink"}`;

  return (
    <>
      <button ref={btn} type="button" className="btn btn-quiet btn-icon !h-8 !w-8" aria-label={label} aria-haspopup="menu" aria-expanded={!!at} onClick={() => setAt(at ? null : { x: 0, y: 0, ready: false })}>
        <Ellipsis size={16} aria-hidden />
      </button>
      {at &&
        createPortal(
          <div ref={pop} role="menu" aria-label={label} onKeyDown={onKey} className="select-pop fixed z-[80] min-w-[200px] overflow-hidden rounded-[10px] border border-line bg-surface p-1 shadow-pop" style={{ left: at.x, top: at.y, visibility: at.ready ? "visible" : "hidden" }}>
            {items.map((it, i) =>
              it === "sep" ? (
                <div key={i} role="separator" className="my-1 h-px bg-line" />
              ) : it.href ? (
                it.external ? (
                  <a key={i} role="menuitem" href={it.href} target="_blank" rel="noopener noreferrer" className={cls(it.danger)} onClick={() => setAt(null)}>{it.label}</a>
                ) : (
                  <Link key={i} role="menuitem" href={it.href} className={cls(it.danger)} onClick={() => setAt(null)}>{it.label}</Link>
                )
              ) : (
                <button key={i} type="button" role="menuitem" disabled={it.disabled} className={cls(it.danger)} onClick={() => { setAt(null); it.onSelect?.(); }}>{it.label}</button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
