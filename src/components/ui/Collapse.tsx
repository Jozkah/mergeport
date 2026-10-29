import type { ReactNode } from "react";

/**
 * Disclosure body that opens and closes by animating grid rows (`.disclosure` in motion.css), never `height`. The content
 * stays mounted so the transition can be reversed mid-way without snapping; while closed it is `inert`, so keyboard focus
 * and assistive technology cannot reach it. Pure markup + CSS: no JavaScript owns the animation.
 */
export function Collapse({ open, children, id, className }: { open: boolean; children: ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className={`disclosure ${className ?? ""}`} data-open={open} inert={!open}>
      <div className="disclosure-inner">{children}</div>
    </div>
  );
}
