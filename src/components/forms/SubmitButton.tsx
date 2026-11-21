"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "@/components/ui/icons";

/**
 * The submit button of every plain `<form action>` (server action or a POST to a route). Disabled while the form is pending, so
 * a double click cannot send it twice. The two labels sit in one grid cell, so the button keeps the width of the longer one and
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
    const onSubmit = (e: Event) => {
      if (!e.defaultPrevented) setNavigating(true);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setNavigating(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
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
      disabled={disabled || busy}
      aria-busy={busy}
      data-loading={busy}
    >
      {iconOnly ? (
        busy ? <LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> : children
      ) : (
        <>
          {busy ? <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" /> : null}
          <span className="inline-grid text-center">
            <span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{children}</span>
            <span className={`col-start-1 row-start-1 ${busy ? "" : "invisible"}`} aria-hidden={!busy}>{pendingLabel}</span>
          </span>
        </>
      )}
    </button>
  );
}

/** A provider link that leaves the page: shows "Redirecting…" and ignores further clicks once pressed. */
export function RedirectLink({ href, children, className = "btn", pendingLabel = "Redirecting…" }: { href: string; children: ReactNode; className?: string; pendingLabel?: string }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return (
    <a
      href={href}
      className={className}
      aria-busy={busy}
      aria-disabled={busy}
      data-loading={busy}
      onClick={(e) => {
        if (busy) e.preventDefault();
        else setBusy(true);
      }}
    >
      {busy ? <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" /> : null}
      <span className="inline-grid text-center">
        <span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{children}</span>
        <span className={`col-start-1 row-start-1 ${busy ? "" : "invisible"}`} aria-hidden={!busy}>{pendingLabel}</span>
      </span>
    </a>
  );
}
