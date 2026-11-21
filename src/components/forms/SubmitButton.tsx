"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "@/components/ui/icons";
import { PendingLabel } from "@/components/ui/PendingLabel";

/**
 * The submit button of every plain `<form action>` (server action or a POST to a route). aria-disabled while the form is pending
 * (it keeps keyboard focus; the click is swallowed), so a double click cannot send it twice. The two labels sit in one grid cell, so the button keeps the width of the longer one and
 * nothing shifts when the label swaps. A string `action` (a POST to a route handler) navigates away without a tracked
 * transition, so the submit event also marks the button busy; a restored page (back button) resets it.
 */
export function SubmitButton({ children, pendingLabel = "Working…", className = "btn btn-primary", disabled, iconOnly = false, ref, ...rest }: Omit<ComponentProps<"button">, "type"> & {
  pendingLabel?: string;
  /** An icon-only button: the spinner replaces the icon and the label is the aria-label. */
  iconOnly?: boolean;
}) {
  const { pending } = useFormStatus();
  const mine = useRef<HTMLButtonElement | null>(null);
  const [navigating, setNavigating] = useState(false);
  useEffect(() => {
    const form = mine.current?.form;
    if (!form) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    // React (function actions, onSubmit handlers) prevents default at the root, after this listener: look one tick later.
    const onSubmit = (e: Event) => {
      // Several submit buttons share one form (demo people): only the one that was pressed goes busy.
      const pressed = (e as SubmitEvent).submitter;
      if (pressed && pressed !== mine.current) return;
      t = setTimeout(() => {
        if (!e.defaultPrevented) setNavigating(true);
      }, 0);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setNavigating(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearTimeout(t);
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  // A POST that never left the page (blocked navigation) lets go again after a while.
  useEffect(() => {
    if (!navigating) return;
    const t = setTimeout(() => setNavigating(false), 10_000);
    return () => clearTimeout(t);
  }, [navigating]);
  const busy = pending || navigating;
  return (
    <button
      {...rest}
      ref={(n) => {
        mine.current = n;
        if (typeof ref === "function") ref(n);
        else if (ref) ref.current = n;
      }}
      type="submit"
      className={className}
      disabled={disabled}
      // aria-disabled (not disabled) while busy: the button keeps keyboard focus, and the click is swallowed.
      aria-disabled={busy || undefined}
      aria-busy={busy}
      data-loading={busy}
      onClick={(e) => {
        if (busy) e.preventDefault();
        else rest.onClick?.(e);
      }}
    >
      {iconOnly ? (
        busy ? <LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> : children
      ) : (
        <PendingLabel mode={busy ? "pending" : "idle"} pending={pendingLabel}>{children}</PendingLabel>
      )}
    </button>
  );
}

/** How long "Redirecting…" is believed before the link can be pressed again (a navigation that never happened). */
const REDIRECT_MS = 10_000;

/** A provider link that leaves the page: shows "Redirecting…" and ignores further clicks once pressed. Modified clicks (new tab) do nothing special. */
export function RedirectLink({ href, children, className = "btn", pendingLabel = "Redirecting…" }: { href: string; children: ReactNode; className?: string; pendingLabel?: string }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), REDIRECT_MS);
    return () => clearTimeout(t);
  }, [busy]);
  return (
    <a
      href={href}
      className={className}
      aria-busy={busy}
      aria-disabled={busy || undefined}
      data-loading={busy}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        // Only a plain primary click leaves this page; a new-tab or download click must not stick on "Redirecting…".
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        setBusy(true);
      }}
    >
      <PendingLabel mode={busy ? "pending" : "idle"} pending={pendingLabel}>{children}</PendingLabel>
    </a>
  );
}
