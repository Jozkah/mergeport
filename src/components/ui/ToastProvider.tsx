"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, CircleAlert, Info, X } from "@/components/ui/icons";
import { millis } from "@/lib/motion";

export type ToastTone = "ok" | "info" | "error";
type Item = { id: number; tone: ToastTone; text: string; leaving: boolean; at: number };
type Api = { show: (tone: ToastTone, text: string) => void };

const Ctx = createContext<Api>({ show: () => {} });
export const useToast = () => useContext(Ctx);

const MAX_VISIBLE = 3;
const OK_MS = 4000;

/**
 * App-wide toasts. At most three are visible; the newest rises in and older ones step back (`.toast` in motion.css),
 * so completion and failure are readable without moving focus. Confirmations dismiss themselves, are paused while the
 * stack is pointed at or focused, and errors stay until dismissed. Escape dismisses the newest. A repeated identical
 * message within 1.5 s is coalesced instead of stacking. Two permanent, visually hidden live regions (status / alert)
 * carry the announcement, so nothing depends on seeing the animation or on a region changing role.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [paused, setPaused] = useState(false);
  const nextId = useRef(1);
  const [spoken, setSpoken] = useState<{ ok: string; error: string }>({ ok: "", error: "" });

  const dismiss = useCallback((id: number) => {
    setItems((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    // A dismissed toast can be the one that held focus or the pointer; its blur / mouseleave never fires once it is gone.
    setPaused(false);
  }, []);

  const show = useCallback((tone: ToastTone, text: string) => {
    const now = Date.now();
    setItems((cur) => {
      if (cur.some((t) => !t.leaving && t.tone === tone && t.text === text && now - t.at < 1500)) return cur;
      // Past the limit the oldest leaves with its exit animation (confirmations first, so an unread error is the last to go).
      let over = cur.filter((t) => !t.leaving).length + 1 - MAX_VISIBLE;
      const evict = new Set<number>();
      for (const pool of [cur.filter((t) => !t.leaving && t.tone !== "error"), cur.filter((t) => !t.leaving && t.tone === "error")]) {
        for (const t of pool) if (over > 0) { evict.add(t.id); over--; }
      }
      return [...cur.map((t) => (evict.has(t.id) ? { ...t, leaving: true } : t)), { id: nextId.current++, tone, text, leaving: false, at: now }];
    });
    // A new string each time so a repeated message is announced again.
    setSpoken((s) => ({ ...s, [tone === "error" ? "error" : "ok"]: text + "​".repeat(now % 3) }));
  }, []);

  // Confirmations leave on their own, unless the person is pointing at or focusing the stack.
  useEffect(() => {
    if (paused) return;
    const timers = items.filter((t) => t.tone !== "error" && !t.leaving).map((t) => setTimeout(() => dismiss(t.id), Math.max(600, OK_MS - (Date.now() - t.at))));
    return () => timers.forEach(clearTimeout);
  }, [items, paused, dismiss]);

  // Toasts that are leaving are removed once their exit has played.
  useEffect(() => {
    if (!items.some((t) => t.leaving)) return;
    const t = setTimeout(() => setItems((cur) => cur.filter((x) => !x.leaving)), millis("--duration-quick", 150));
    return () => clearTimeout(t);
  }, [items]);

  useEffect(() => {
    if (items.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return; // a dialog, tooltip or drag that used Escape keeps it
      const newest = [...items].reverse().find((t) => !t.leaving);
      if (newest) dismiss(newest.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items, dismiss]);

  const api = useMemo(() => ({ show }), [show]);
  const visible = items.filter((t) => !t.leaving);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{spoken.ok}</div>
      <div className="sr-only" role="alert" aria-atomic="true">{spoken.error}</div>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div className="toast-stack" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
          {items.map((t) => {
            const index = visible.length - 1 - visible.findIndex((v) => v.id === t.id);
            return (
              <div
                key={t.id}
                className="toast pointer-events-auto flex max-w-[min(480px,calc(100vw-32px))] items-start gap-2 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13px] shadow-pop"
                style={{ "--i": t.leaving ? 0 : Math.max(0, index) } as CSSProperties}
                data-leaving={t.leaving ? "true" : undefined}
                data-tone={t.tone}
              >
                {t.tone === "ok" ? <Check size={15} aria-hidden className="mt-0.5 shrink-0 text-ok" /> : t.tone === "info" ? <Info size={15} aria-hidden className="mt-0.5 shrink-0 text-ink-3" /> : <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-blocked" />}
                <span className="min-w-0 [overflow-wrap:anywhere]" aria-hidden>{t.text}</span>
                <button type="button" className="btn btn-quiet btn-icon !h-6 !w-6 shrink-0" aria-label={`Dismiss: ${t.text}`} onClick={() => dismiss(t.id)}>
                  <X size={13} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Ctx.Provider>
  );
}
