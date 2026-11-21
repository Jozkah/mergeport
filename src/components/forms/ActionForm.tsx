"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
import { CircleAlert, LoaderCircle } from "@/components/ui/icons";
import { useSheetClose } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/ToastProvider";
import { CopyField } from "./CopyField";

/** A success line leaves by itself after this long; an error stays until the next edit. */
const OK_CLEAR_MS = 4000;

/**
 * Form wrapper for server actions.
 * - Drafts survive failures: the form is only reset after a successful result.
 * - Double submits are impossible: the submit button is disabled while pending.
 * - Errors are announced (role=alert) and retryable.
 * - Result lifecycle: the message clears on the next edit or submit; a success line also clears itself after ~4 s; an error stays.
 * - `onDone` may return true (or pass `keepBusyOnDone`) to stay pending until the page navigates away; the button then says "Redirecting…".
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
  /** "inline": the form is one row (field + button) with no top margin on the action row, replacing hand-written margin overrides. */
  layout?: "stack" | "inline";
  /** No button: the form is sent by something else (a Select with autoSubmit). The status and error lines stay. */
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

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || submitDisabled || (requireDirty && !dirty)) return;
    setSlow(false);
    setMsgVisible(false);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      let r: ActionResult;
      try {
        r = await action(fd);
      } catch {
        // Offline or the server is unreachable. The input is kept so nothing has to be retyped.
        r = { ok: false, error: "Could not reach the server. Your input is kept. Check your connection and try again.", retryable: true };
      }
      setResult(r);
      setMsgVisible(true);
      setSeq((n) => n + 1);
      if (r.ok && resetOnSuccess) ref.current?.reset();
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
      <div ref={row} className={`${layout === "inline" ? "" : "mt-3 "}flex flex-wrap items-center`} onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("shake"); }}>
        {hideSubmit ? (
          busy ? <LoaderCircle size={14} aria-hidden className="animate-spin text-ink-3 motion-reduce:animate-none" /> : null
        ) : <button type="submit" className={submitClassName} disabled={busy || submitDisabled || (requireDirty && !dirty)} data-loading={busy} aria-busy={busy} aria-label={submitAriaLabel}>
          {busy ? <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" /> : null}
          {/* Stacked labels: the button keeps the width of the longest one, so swapping never moves its neighbours. */}
          <span className="inline-grid text-center">
            <span className={`col-start-1 row-start-1 ${mode === "idle" ? "" : "invisible"}`} aria-hidden={mode !== "idle"}>{submitLabel}</span>
            <span className={`col-start-1 row-start-1 ${mode === "pending" ? "" : "invisible"}`} aria-hidden={mode !== "pending"}>{pendingLabel}</span>
            {keepBusyOnDone || holding ? <span className={`col-start-1 row-start-1 ${mode === "hold" ? "" : "invisible"}`} aria-hidden={mode !== "hold"}>Redirecting…</span> : null}
          </span>
        </button>}
        {secondary ? <span className="ml-2 inline-flex flex-wrap items-center gap-2">{secondary}</span> : null}
        {/* Two permanent regions: a region that changes role in the same render it gains text is often not announced. */}
        <p role="status" aria-live="polite" className="ml-2 min-h-5 text-[12.5px] empty:ml-0">
          {pending && slow && <span className="text-ink-3">Still working. This is taking longer than usual; your input is kept.</span>}
          {/* A neutral outcome (data.neutral) is information, not a success and not a failure: plain text colour, no check. */}
          {!busy && msgVisible && result?.ok && result.data?.neutral === true && (
            <span key={seq} className="result-in text-ink-2">{result.message}</span>
          )}
          {!busy && msgVisible && result?.ok && result.data?.neutral !== true && (
            <span key={seq} className="result-in inline-flex items-center gap-1 text-ok">
              <svg className="check-draw shrink-0" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" pathLength={1} />
              </svg>
              {result.message ?? "Saved"}
            </span>
          )}
        </p>
        {/* min-h keeps the line's height reserved, so an error appearing does not push the neighbours. */}
        <p role="alert" className="min-h-5 text-[12.5px] [&:not(:empty)]:ml-2">
          {msgVisible && result && !result.ok && (
            <span key={seq} className="result-in inline-flex items-start gap-1 text-blocked">
              <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" /> {result.error}
            </span>
          )}
        </p>
      </div>
      {result?.ok && success?.copy && result.data?.[success.copy.field] ? (
        <div className="mt-2"><CopyField absolute={success.copy.absolute} label={success.copy.label} value={String(result.data[success.copy.field])} hint={success.copy.hint} /></div>
      ) : null}
      {result?.ok && success?.link ? <div className="mt-2"><a className="btn btn-primary" href={success.link.href}>{success.link.label}</a></div> : null}
    </form>
  );
}
