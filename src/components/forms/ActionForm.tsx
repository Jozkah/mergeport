"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
import { CircleAlert, LoaderCircle } from "@/components/ui/icons";
import { PendingLabel } from "@/components/ui/PendingLabel";
import { useSheetClose } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/ToastProvider";
import { CopyField } from "./CopyField";

/** A success line leaves by itself after this long; an error stays until the next edit. */
const OK_CLEAR_MS = 4000;
/** A held button (waiting for a navigation that never came) lets go again after this long. */
const HOLD_MS = 10_000;

/**
 * Form wrapper for server actions.
 * - Drafts survive failures: the form is only reset after a successful result.
 * - Double submits are impossible: while pending the button is aria-disabled (it keeps keyboard focus) and the submit is ignored.
 * - Errors are announced (role=alert) and retryable; an error with `field` marks that field invalid and focuses it.
 * - Result lifecycle: the message clears on the next edit or submit; a success line also clears itself after ~4 s; an error stays.
 * - `onDone` may return true (or pass `keepBusyOnDone`) to stay pending until the page navigates away; the button then says
 *   "Redirecting…", and lets go again after 10 s if the page never left.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Working…",
  className,
  resetOnSuccess = true,
  closeOnSuccess = false,
  onDone,
  keepBusyOnDone = false,
  secondary,
  success,
  submitClassName = "btn btn-primary",
  submitAriaLabel,
  submitDisabled = false,
  submitDisabledReason,
  layout = "stack",
  hideSubmit = false,
  requireDirty = false,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  resetOnSuccess?: boolean;
  /** Inside a Sheet: close the dialog after a successful submit (and say so in a toast). A failure keeps it open with the input intact. */
  closeOnSuccess?: boolean;
  /** Return true to keep the button pending after a success (the page is about to navigate). */
  onDone?: (r: ActionResult) => void | boolean;
  keepBusyOnDone?: boolean;
  secondary?: ReactNode;
  /** Server Components cannot pass functions, so the success output is described as data. */
  success?: { copy?: { field: string; label: string; hint?: string; absolute?: boolean }; link?: { href: string; label: string } };
  submitClassName?: string;
  /** Distinguishes repeated buttons ("Refresh" in every row) for assistive technology. */
  submitAriaLabel?: string;
  /** A form that cannot be submitted yet (nothing changed, a box not ticked). */
  submitDisabled?: boolean;
  /** Why the button is off; read out with it (`aria-describedby`). */
  submitDisabledReason?: string;
  /** "inline": the form is one row (field + button): no top margin, the success line becomes a toast, errors stay in the row. */
  layout?: "stack" | "inline";
  /** No button: the form is sent by something else (a Select with autoSubmit). The status and error lines stay. A rejected send resets the form to what is stored. */
  hideSubmit?: boolean;
  /** The button stays off until a field differs from what the form loaded with (and again after a save). For settings. */
  requireDirty?: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [msgVisible, setMsgVisible] = useState(true);
  const [seq, setSeq] = useState(0);
  const [holding, setHolding] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(false);
  const closeSheet = useSheetClose();
  const toast = useToast();
  const busy = pending || holding;
  const alertId = useId();
  const reasonId = `${alertId}-why`;
  const inline = layout === "inline";
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const snapshot = () => (ref.current ? JSON.stringify([...new FormData(ref.current).entries()].map(([k, v]) => [k, typeof v === "string" ? v : "file"])) : "");
  useEffect(() => {
    if (requireDirty) baseline.current = snapshot();
  }, [requireDirty]);
  const checkDirty = () => {
    if (requireDirty && baseline.current !== null) setDirty(snapshot() !== baseline.current);
  };

  // Real pending work only: after a few seconds say so in words, so a slow network is not mistaken for a dead button.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [pending]);

  // "Redirecting…" promises the page is about to leave. If it does not (blocked navigation), let go again.
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHolding(false), HOLD_MS);
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setHolding(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pageshow", onShow);
    };
  }, [holding]);

  // A success line is confirmation, not a record: it leaves after a few seconds. Errors are never timed out.
  useEffect(() => {
    if (!result?.ok || !msgVisible) return;
    const t = setTimeout(() => setMsgVisible(false), OK_CLEAR_MS);
    return () => clearTimeout(t);
  }, [result, seq, msgVisible]);

  // A failed submit nudges the action row once (not the whole form, and never the focused field). The message is the real feedback.
  const failed = !!result && !result.ok && msgVisible;
  useEffect(() => {
    const el = row.current;
    if (!failed || !el) return;
    el.classList.remove("shake");
    void el.offsetWidth; // restart the animation for a second failure in a row
    el.classList.add("shake");
  }, [failed, seq]);

  // An error about one field: mark it invalid, point it at the message and put the keyboard there.
  const errField = failed && result && !result.ok ? result.field : undefined;
  useEffect(() => {
    if (!errField) return;
    const el = ref.current?.elements.namedItem(errField);
    let target = el instanceof HTMLElement ? el : null;
    // A Select posts through a hidden or invisible input; the person's control is the combobox beside it.
    if (target instanceof HTMLInputElement && (target.type === "hidden" || target.tabIndex === -1)) target = target.parentElement?.querySelector<HTMLElement>('[role="combobox"]') ?? target;
    if (!target) return;
    const before = target.getAttribute("aria-describedby");
    target.setAttribute("aria-invalid", "true");
    target.setAttribute("aria-describedby", [before, alertId].filter(Boolean).join(" "));
    target.focus();
    return () => {
      target.removeAttribute("aria-invalid");
      if (before) target.setAttribute("aria-describedby", before);
      else target.removeAttribute("aria-describedby");
    };
  }, [errField, seq, alertId]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || submitDisabled || (requireDirty && !dirty)) return;
    setSlow(false);
    setMsgVisible(false);
    setHolding(false);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      let r: ActionResult;
      try {
        r = await action(fd);
      } catch {
        // Offline or the server is unreachable. The input is kept so nothing has to be retyped.
        r = { ok: false, error: "Could not reach the server. Your input is kept. Check your connection and try again.", retryable: true };
      }
      // Reset FIRST: the form's reset handler clears the message, so a reset after setResult would swallow the success line.
      // A rejected autosave (no button) resets as well, so its Select shows what is stored instead of the refused choice.
      if ((r.ok && resetOnSuccess) || (!r.ok && hideSubmit)) ref.current?.reset();
      setResult(r);
      setMsgVisible(true);
      setSeq((n) => n + 1);
      if (r.ok && inline && !closeOnSuccess && r.data?.neutral !== true) toast.show("ok", r.message ?? "Saved");
      if (r.ok && requireDirty) {
        baseline.current = snapshot(); // what was just saved is the new starting point
        setDirty(false);
      }
      if (r.ok && closeOnSuccess) {
        closeSheet?.();
        if (r.data?.neutral !== true) toast.show("ok", r.message ?? "Saved");
      }
      const hold = onDone?.(r);
      if (r.ok && (hold === true || keepBusyOnDone)) setHolding(true);
    });
  }

  const mode = holding ? "hold" : pending ? "pending" : "idle";
  return (
    <form
      ref={ref}
      onSubmit={submit}
      // Typing clears the previous outcome, so a stale error never sits beside a corrected field. Reset does not fire input.
      onInput={() => { if (result && msgVisible) setMsgVisible(false); checkDirty(); }}
      onChange={checkDirty}
      onReset={() => { setMsgVisible(false); setDirty(false); }}
      className={className}
      aria-busy={busy}
    >
      {children}
      <div ref={row} className={`${inline ? "" : "mt-3 "}flex flex-wrap items-center`} onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("shake"); }}>
        {hideSubmit ? (
          busy ? <LoaderCircle size={14} aria-hidden className="animate-spin text-ink-3 motion-reduce:animate-none" /> : null
        ) : (
          <button
            type="submit"
            className={submitClassName}
            // `disabled` only for "cannot be sent yet"; while busy the button stays focusable (aria-disabled) so the keyboard is not dropped to the page.
            disabled={submitDisabled || (requireDirty && !dirty)}
            aria-disabled={busy || undefined}
            data-loading={busy}
            aria-busy={busy}
            aria-label={submitAriaLabel}
            aria-describedby={submitDisabled && submitDisabledReason ? reasonId : undefined}
            onClick={(e) => { if (busy) e.preventDefault(); }}
          >
            <PendingLabel mode={mode} pending={pendingLabel} hold={keepBusyOnDone || onDone ? "Redirecting…" : undefined}>{submitLabel}</PendingLabel>
          </button>
        )}
        {secondary ? <span className="ml-2 inline-flex flex-wrap items-center gap-2">{secondary}</span> : null}
        {/* A region that changes role in the same render it gains text is often not announced, so status and alert are permanent.
            An inline row has no room for a reserved line: its success is a toast, and only an error makes it grow. */}
        <p role="status" aria-live="polite" className={`ml-2 text-[12.5px] empty:ml-0 ${inline ? "" : "min-h-5"}`}>
          {pending && slow && <span className="text-ink-3">Still working. This is taking longer than usual; your input is kept.</span>}
          {/* A neutral outcome (data.neutral) is information, not a success and not a failure: plain text colour, no check. */}
          {!inline && !busy && msgVisible && result?.ok && result.data?.neutral === true && (
            <span key={seq} className="result-in text-ink-2">{result.message}</span>
          )}
          {!inline && !busy && msgVisible && result?.ok && result.data?.neutral !== true && (
            <span key={seq} className="result-in inline-flex items-center gap-1 text-ok">
              <svg className="check-draw shrink-0" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" pathLength={1} />
              </svg>
              {result.message ?? "Saved"}
            </span>
          )}
        </p>
        <p id={alertId} role="alert" className={`text-[12.5px] [&:not(:empty)]:ml-2 ${inline ? "" : "min-h-5"}`}>
          {msgVisible && result && !result.ok && (
            <span key={seq} className="result-in inline-flex items-start gap-1 text-blocked">
              <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" /> {result.error}
            </span>
          )}
        </p>
        {submitDisabledReason ? <span id={reasonId} className="sr-only">{submitDisabledReason}</span> : null}
      </div>
      {result?.ok && success?.copy && result.data?.[success.copy.field] ? (
        <div className="mt-2"><CopyField absolute={success.copy.absolute} label={success.copy.label} value={String(result.data[success.copy.field])} hint={success.copy.hint} /></div>
      ) : null}
      {result?.ok && success?.link ? <div className="mt-2"><a className="btn btn-primary" href={success.link.href}>{success.link.label}</a></div> : null}
    </form>
  );
}
