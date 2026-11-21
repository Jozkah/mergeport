"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-reads the page from the server on a timer while it is open and visible, so a linked board follows the other instance without a
 * manual reload. Nothing runs while the tab is hidden or the browser is offline; when the tab comes back and the last refresh is
 * older than the interval, one catch-up refresh happens at once (the same rule as sync/LiveRefresh). Listeners and the timer are
 * removed on cleanup. LiveRefresh only reacts to events from this server, so it does not cover a peer's data: this stays.
 */
export function AutoRefresh({ seconds = 90 }: { seconds?: number }) {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    const interval = seconds * 1000;
    last.current = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      last.current = Date.now();
      router.refresh();
    };
    const t = setInterval(refresh, interval);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= interval) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, seconds]);
  return null;
}
