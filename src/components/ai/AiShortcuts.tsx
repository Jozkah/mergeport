import type { ReactNode } from "react";

/** A row of AI shortcut buttons for the top of a page. `show` is false until the AI endpoint is set up, and in the demo. */
export function AiShortcuts({ show, children, className = "mb-4" }: { show: boolean; children: ReactNode; className?: string }) {
  if (!show) return null;
  return <div className={`flex flex-wrap gap-x-4 gap-y-3 ${className}`}>{children}</div>;
}
