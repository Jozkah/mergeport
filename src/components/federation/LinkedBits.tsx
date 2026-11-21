"use client";

import { useEffect } from "react";

/** A board-shaped placeholder (three columns of cards) while the other instance answers. The shared `.skeleton` pulse; nothing else moves. */
export function BoardSkeleton({ columns = 3 }: { columns?: number }) {
  return (
    <div className="linked-board" role="status" aria-busy="true" aria-label="Loading the board">
      {Array.from({ length: columns }, (_, c) => (
        <div key={c} className="panel" aria-hidden>
          <div className="panel-head"><div className="skeleton h-4 w-24" /></div>
          <div className="panel-body flex flex-col gap-2 p-2">
            {Array.from({ length: c === 1 ? 2 : 3 }, (_, i) => (
              <div key={i} className="skeleton h-[74px] rounded-[10px]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A panel-shaped placeholder for one peer's project list. */
export function PeerSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading projects" className="flex flex-col gap-2 p-4">
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-4 w-1/2" />
      <div className="skeleton h-4 w-3/5" />
    </div>
  );
}

/**
 * The result of linking arrives as `?result=`. The banner is rendered with the page; once it has painted the query is removed from
 * the address (history.replaceState: Next folds it into its router state), so a refresh or a shared address does not bring it back.
 */
export function StripResult({ to }: { to: string }) {
  useEffect(() => {
    try {
      window.history.replaceState(window.history.state, "", to);
    } catch {
      // The banner simply stays in the address; nothing depends on this.
    }
  }, [to]);
  return null;
}
