"use client";

import { useState, useTransition } from "react";
import { markDigestReadAction, regenerateDigestAction } from "@/app/digest-actions";
import { Check, RefreshCw } from "@/components/ui/icons";
import { useToast } from "@/components/ui/ToastProvider";

/** Rebuild and mark-read for one stored digest. Personal and local: nothing is sent to GitHub or to teammates. */
export function DigestActions({ day, read }: { day: string; read: boolean }) {
  const { show } = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (fn: (d: string) => ReturnType<typeof markDigestReadAction>) =>
    start(async () => {
      const r = await fn(day);
      setError(r.ok ? null : r.error);
      if (r.ok && r.message) show("ok", r.message);
    });
  return (
    <>
      {error && <span role="alert" className="text-[12px] text-blocked">{error}</span>}
      <button type="button" className="btn" disabled={pending} onClick={() => go(regenerateDigestAction)} title="Build this digest again from the data on this computer now">
        <RefreshCw size={14} aria-hidden /> Regenerate
      </button>
      <button type="button" className="btn" disabled={pending || read} onClick={() => go(markDigestReadAction)}>
        <Check size={14} aria-hidden /> {read ? "Marked read" : "Mark read"}
      </button>
    </>
  );
}
