"use client";

import { useCallback, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { X } from "@/components/ui/icons";

const EVENT = "mp:banners";
const storeKey = (key: string) => `mp.banner.${key}`;
/** Whether the banner with this key was dismissed on this device; false when storage is missing or throws. */
export const isDismissed = (key: string | undefined) => {
  if (!key) return false;
  try {
    return localStorage.getItem(storeKey(key)) === "1";
  } catch {
    return false;
  }
};
/** Remembers a dismissal; returns false when storage refused it (the banner still hides for this visit). */
export const rememberDismissal = (key: string) => {
  try {
    localStorage.setItem(storeKey(key), "1");
    return true;
  } catch {
    return false;
  }
};
const noop = () => () => {};

/**
 * The client half of `Banner dismissible`. A dismissal is remembered per `storageKey` in localStorage; when storage is
 * unavailable it still hides for this visit. No flash for a banner dismissed earlier: the server cannot know, so during
 * hydration a tiny inline script right after the banner hides it before first paint, and React then drops it.
 */
export function DismissibleBanner({ storageKey, role, className, style, label, children }: { storageKey?: string; role: string; className: string; style: CSSProperties; label: string; children: ReactNode }) {
  const sub = useCallback((fn: () => void) => {
    window.addEventListener(EVENT, fn);
    return () => window.removeEventListener(EVENT, fn);
  }, []);
  const stored = useSyncExternalStore(sub, () => isDismissed(storageKey), () => false);
  const hydrating = useSyncExternalStore(noop, () => false, () => true);
  const [closed, setClosed] = useState(false);
  if (closed || stored) return null;
  const dismiss = () => {
    setClosed(true);
    if (storageKey && rememberDismissal(storageKey)) window.dispatchEvent(new Event(EVENT));
  };
  return (
    <>
      <div role={role} className={className} style={style} suppressHydrationWarning>
        {children}
        <button type="button" onClick={dismiss} aria-label={label} title="Dismiss" className="btn btn-quiet btn-icon -my-2 -mr-1.5 !h-10 !w-10 shrink-0">
          <X size={14} aria-hidden />
        </button>
      </div>
      {hydrating && storageKey && (
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem(${JSON.stringify(storeKey(storageKey)).replace(/</g, "\\u003c")})==="1")document.currentScript.previousElementSibling.hidden=true}catch(e){}` }} />
      )}
    </>
  );
}
