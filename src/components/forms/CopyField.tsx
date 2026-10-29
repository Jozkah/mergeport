"use client";

import { useState } from "react";
import { Check, Copy } from "@/components/ui/icons";

/** Read-only value with a copy button. Falls back to selectable text when the clipboard API is unavailable. */
export function CopyField({ label, value, hint, absolute = false }: { label: string; value: string; hint?: string; absolute?: boolean }) {
  const [copied, setCopied] = useState(false);
  const shown = absolute && typeof window !== "undefined" && value.startsWith("/") ? window.location.origin + value : value;
  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the field is selectable; people can copy manually */
    }
  }
  return (
    <div>
      <label className="label" htmlFor={`cf-${label}`}>{label}</label>
      <div className="flex gap-2">
        <input id={`cf-${label}`} readOnly value={shown} className="input mono" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={copy}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? "Copied" : "Copy"}</button>
      </div>
      {hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}
