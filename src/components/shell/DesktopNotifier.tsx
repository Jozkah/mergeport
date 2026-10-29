"use client";

import { useEffect } from "react";

const EVERY_MS = 60_000;
const KEY = "mp.notify.after";

/**
 * Shows desktop notifications for things the server says this person asked to be told about (their own preferences and quiet hours
 * are applied there). It does nothing unless the browser permission was granted, and it only runs while Mergeport is open.
 */
export function DesktopNotifier() {
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let live = true;
    const read = () => {
      try {
        return Number(sessionStorage.getItem(KEY)) || Date.now();
      } catch {
        return Date.now();
      }
    };
    let after = read();
    const tick = async () => {
      try {
        const res = await fetch(`/api/notifications/poll?after=${after}`, { cache: "no-store" });
        if (!res.ok || !live) return;
        const body = (await res.json()) as { now: number; items: { id: string; title: string; href: string | null; at: number }[] };
        for (const n of body.items) {
          const note = new Notification(n.title, { tag: n.id });
          note.onclick = () => {
            window.focus();
            if (n.href) window.location.assign(n.href);
          };
        }
        after = body.items.length ? Math.max(...body.items.map((i) => i.at)) : after;
        try {
          sessionStorage.setItem(KEY, String(after));
        } catch {
          // not remembered: a reload may repeat a pop-up
        }
      } catch {
        // offline: try again next time
      }
    };
    const t = setInterval(tick, EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return null;
}
