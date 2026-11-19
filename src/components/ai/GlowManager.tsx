"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { GLOW_EVENT, clearGlow, readGlow, type Glow } from "@/lib/glow";
import { X } from "@/components/ui/icons";

const CLASS = "ai-glow";
const STILL = "ai-glow-still";
const ROW = "li, tr, article, [data-row]";
const NOTE = "data-ai-note";

/**
 * Makes the pull requests the AI pointed at stand out wherever the current page lists them, and keeps a small bar at the bottom to
 * jump to the first one or turn it off. It only adds a CSS class and a screen-reader note to existing rows; it never clicks, submits
 * or changes anything, and it leaves the AI's own panels alone (they carry data-no-glow).
 */
export function GlowManager() {
  const path = usePathname();
  const [glow, setGlow] = useState<Glow | null>(null);
  const played = useRef(new Set<string>()); // links whose ring has already played: a re-render marks them again, but quietly
  const scrolled = useRef("");

  const clearMarks = useCallback(() => {
    const main = document.querySelector("main");
    main?.querySelectorAll(`.${CLASS}`).forEach((el) => el.classList.remove(CLASS, STILL));
    main?.querySelectorAll(`[${NOTE}]`).forEach((el) => el.remove());
  }, []);

  const apply = useCallback(
    (g: Glow | null) => {
      const main = document.querySelector("main");
      if (!main) return;
      clearMarks();
      if (!g) return;
      for (const href of g.hrefs) {
        main.querySelectorAll<HTMLAnchorElement>(`a[href="${CSS.escape(href)}"]`).forEach((a) => {
          if (a.closest("[data-no-glow]")) return;
          const row = a.closest(ROW) ?? a; // the row that holds the link; the link itself when the page has no rows
          row.classList.add(CLASS);
          if (played.current.has(href)) row.classList.add(STILL);
          if (!a.querySelector(`[${NOTE}]`)) {
            const note = document.createElement("span");
            note.className = "sr-only";
            note.setAttribute(NOTE, "");
            note.textContent = " (the AI is pointing at this)";
            a.appendChild(note);
          }
        });
        played.current.add(href);
      }
    },
    [clearMarks],
  );

  useEffect(() => {
    const sync = () => setGlow(readGlow());
    sync();
    window.addEventListener(GLOW_EVENT, sync);
    return () => window.removeEventListener(GLOW_EVENT, sync);
  }, [path]);

  const signature = glow ? glow.hrefs.join("|") : "";

  useEffect(() => {
    apply(glow);
    if (!glow) {
      played.current.clear();
      scrolled.current = "";
      return;
    }
    const main = document.querySelector("main");
    if (!main) return;
    // Lists fill in after navigation and refresh on their own: re-mark when the page changes.
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => apply(readGlow()), 120);
    });
    mo.observe(main, { childList: true, subtree: true });
    const expire = setTimeout(() => setGlow(readGlow()), Math.max(1000, glow.until - Date.now()));
    // Scroll to the first one once per set of items and page, not each time one of them is opened.
    const sig = `${signature}@${path}`;
    if (scrolled.current !== sig) {
      const first = main.querySelector(`.${CLASS}`);
      if (first) {
        scrolled.current = sig;
        first.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    }
    return () => {
      mo.disconnect();
      clearTimeout(t);
      clearTimeout(expire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, path, apply]);

  // Opening a highlighted item counts as having seen it.
  useEffect(() => {
    if (!glow) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = a?.getAttribute("href");
      if (href && glow.hrefs.includes(href)) clearGlow(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [glow]);

  // While the bar is up, keyboard focus and scrolling keep clear of it.
  useEffect(() => {
    if (!glow) return;
    const html = document.documentElement;
    const before = html.style.scrollPaddingBottom;
    html.style.scrollPaddingBottom = "5rem";
    return () => {
      html.style.scrollPaddingBottom = before;
    };
  }, [glow]);

  if (!glow) return null;
  const n = glow.hrefs.length;
  return (
    <div role="region" aria-label="The AI is pointing at items" className="glow-bar fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-4 pr-1 text-[12.5px] shadow-pop">
      <span className="whitespace-nowrap"><span className="tnum">{n}</span> pointed out by the AI</span>
      <Link href={glow.hrefs[0]} className="btn btn-quiet !h-8 !px-3 whitespace-nowrap">Open the first</Link>
      <button type="button" className="btn btn-quiet btn-icon !h-8 !w-8 !rounded-full" aria-label="Stop highlighting" onClick={() => clearGlow()}><X size={14} aria-hidden /></button>
    </div>
  );
}
