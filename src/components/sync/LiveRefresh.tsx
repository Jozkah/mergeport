"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { startLiveRefresh, type StreamLike } from "@/lib/sync/live-refresh";

/**
 * Keeps the open page current without a manual reload: listens for change events from the local server (a teammate's
 * edit arrived, a push finished) and refreshes the server-rendered data. Refreshes are debounced with a maximum wait and
 * a minimum gap, skipped while the tab is hidden (one catch-up refresh happens when it becomes visible), and never replay
 * entrance animations; scroll position and focus are preserved by router.refresh(). It also tells the server whether
 * this tab is visible so background polling can slow down, and reconnects if the stream drops. It goes quiet while a
 * workspace switch restarts the app (see `startLiveRefresh`).
 */
export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const open = (): StreamLike => {
      const es = new EventSource("/api/sync/events");
      const s: StreamLike = { onopen: null, onmessage: null, onerror: null, close: () => es.close() };
      es.onopen = () => s.onopen?.();
      es.onmessage = (e) => s.onmessage?.({ data: String(e.data) });
      es.onerror = () => s.onerror?.();
      return s;
    };
    const live = startLiveRefresh({ open, refresh: () => router.refresh(), isVisible: () => document.visibilityState === "visible" });
    const report = () => {
      void fetch("/api/sync/visibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visible: document.visibilityState === "visible" }) }).catch(() => {});
      if (document.visibilityState === "visible") live.catchUp();
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => {
      live();
      document.removeEventListener("visibilitychange", report);
    };
  }, [router]);
  return null;
}
