import type { ReactNode } from "react";
import { ChevronDown } from "@/components/ui/icons";

/**
 * A native `<details>` (works without JavaScript) with the shared look: a 40 px summary row, a chevron that turns when open
 * (existing .disclosure motion tokens), and a visible keyboard focus ring. `summary` is the always-visible row; `meta` sits at its
 * end (a count, a one-line digest) and `children` is the folded body.
 */
export function Disclosure({ summary, meta, children, className = "", defaultOpen = false }: { summary: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details className={`group ${className}`} open={defaultOpen || undefined} data-initial-open={defaultOpen ? "" : undefined}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-[8px] text-[13px] outline-none transition-colors duration-[var(--duration-feedback)] hover:text-ink focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] [&::-webkit-details-marker]:hidden">
        <ChevronDown size={14} aria-hidden className="shrink-0 -rotate-90 text-ink-3 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] group-open:rotate-0" />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {meta ? <span className="min-w-0 max-w-[55%] shrink-0 truncate text-[12.5px] text-ink-3" title={typeof meta === "string" ? meta : undefined}>{meta}</span> : null}
      </summary>
      <div className="disc-body pb-2 pl-6">{children}</div>
    </details>
  );
}
