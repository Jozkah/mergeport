"use client";

import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * Tooltip for icon-only controls and status chips. It supplements an accessible name; it never replaces one.
 * Opens after a short intent delay (80 ms, so a passing pointer does not trigger it), appears with a small scale + rise
 * (`.tip` in motion.css), and closes faster than it opened. Moving between neighbouring triggers skips the delay.
 * Keyboard focus opens it too; Escape closes it.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={80} skipDelayDuration={300}>
      {children}
    </T.Provider>
  );
}

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="tip z-[60] max-w-[260px] rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-snug text-ink shadow-pop">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
