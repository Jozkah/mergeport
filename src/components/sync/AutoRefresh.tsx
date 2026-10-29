"use client";

import { useEffect, useRef, useTransition } from "react";
import { LoaderCircle, RefreshCw } from "@/components/ui/icons";
import { refreshDiscoveryAction } from "@/app/team-actions";

/**
 * Asks the server to refresh one cached GitHub list IN THE BACKGROUND and returns at once. The page keeps showing the
 * saved list; when the refresh finishes the server tells the open page (LiveRefresh) and it re-renders. With `auto`, a
 * stale or empty list is requested once when the page opens.
 */
export function AutoRefresh({ listKey, auto, busy, label = "Check again" }: { listKey: string; auto: boolean; busy: boolean; label?: string }) {
  const [pending, start] = useTransition();
  const asked = useRef(false);
  const ask = () =>
    start(async () => {
      const fd = new FormData();
      fd.set("key", listKey);
      await refreshDiscoveryAction(fd).catch(() => {});
    });
  useEffect(() => {
    if (!auto || asked.current) return;
    asked.current = true;
    ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);
  return (
    <button type="button" className="btn !h-7" onClick={ask} disabled={pending || busy} aria-label={`${label}: ask GitHub again in the background`}>
      {pending || busy ? <LoaderCircle size={13} aria-hidden className="animate-spin" /> : <RefreshCw size={13} aria-hidden />} {pending || busy ? "Checking…" : label}
    </button>
  );
}
