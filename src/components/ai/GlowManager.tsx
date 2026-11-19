"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { GLOW_EVENT, clearGlow, readGlow, type Glow } from "@/lib/glow";
import { X } from "@/components/ui/icons";

const CLASS = "ai-glow";
const ROW = "li, tr, article, [data-row]";

/**
 * Makes the pull requests the AI pointed at glow wherever the current page lists them, and keeps a small bar at the bottom to
 * jump to the first one or turn the glow off. It only adds a CSS class to existing rows; it never clicks, submits or changes anything.
 */
export function GlowManager() {
  const path = usePathname();
  const router = useRouter();
  const [glow, setGlow] = useState<Glow | null>(null);

  const apply = useCallback((g: Glow | null) => {
    const main = document.querySelector("main");
    if (!main) return;
    main.querySelectorAll(`.${CLASS}`).forEach((el) => el.classList.remove(CLASS));
    if (!g) return;
    for (const href of g.hrefs) {
      main.querySelectorAll<HTMLAnchorElement>(`a[href="${CSS.escape(href)}"]`).forEach((a) => {
        // The row that holds the link; the link itself when the page has no rows (a detail page, a card).
        (a.closest(ROW) ?? a).classList.add(CLASS);
      });
    }
  }, []);

  useEffect(() => {
    const sync = () => setGlow(readGlow());
    sync();
    window.addEventListener(GLOW_EVENT, sync);
    return () => window.removeEventListener(GLOW_EVENT, sync);
  }, [path]);

  useEffect(() => {
    apply(glow);
    if (!glow) return;
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
    const first = main.querySelector(`.${CLASS}`);
    first?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return () => {
      mo.disconnect();
      clearTimeout(t);
      clearTimeout(expire);
    };
  }, [glow, path, apply]);

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

  if (!glow) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 text-[12.5px] shadow-pop">
      <span>The AI is pointing at {glow.hrefs.length} item{glow.hrefs.length === 1 ? "" : "s"}</span>
      <button type="button" className="underline" onClick={() => router.push(glow.hrefs[0])}>Open the first</button>
      <button type="button" className="btn btn-quiet btn-icon !h-6 !w-6" aria-label="Stop highlighting" onClick={() => clearGlow()}><X size={12} aria-hidden /></button>
    </div>
  );
}
