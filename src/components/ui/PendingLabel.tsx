import type { ReactNode } from "react";
import { LoaderCircle } from "@/components/ui/icons";

/**
 * The label of every button that can be busy. All labels share ONE grid cell and the spinner sits inside the busy label's
 * cell, so the button always has the width of its widest state: going busy never grows it or moves its neighbours.
 * `mode` picks the visible label; `hold` (e.g. "Redirecting…") is only laid out when given.
 */
export function PendingLabel({ mode, children, pending = "Working…", hold, size = 14 }: { mode: "idle" | "pending" | "hold"; children: ReactNode; pending?: ReactNode; hold?: ReactNode; size?: number }) {
  const cell = "col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5";
  return (
    <span className="inline-grid">
      <span className={`${cell} ${mode === "idle" ? "" : "invisible"}`} aria-hidden={mode !== "idle"}>{children}</span>
      <span className={`${cell} ${mode === "pending" ? "" : "invisible"}`} aria-hidden={mode !== "pending"}>
        <LoaderCircle size={size} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" />
        {pending}
      </span>
      {hold ? (
        <span className={`${cell} ${mode === "hold" ? "" : "invisible"}`} aria-hidden={mode !== "hold"}>
          <LoaderCircle size={size} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" />
          {hold}
        </span>
      ) : null}
    </span>
  );
}
