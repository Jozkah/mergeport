"use client";

import { useEffect } from "react";

/** A page that throws must not take the navigation with it: this boundary sits inside the app layout. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="panel max-w-[560px]">
      <div className="panel-body p-6" role="alert">
        <h1 className="text-[20px] font-medium">This page could not be shown</h1>
        <p className="mt-2 text-[13px] text-ink-3">Nothing was changed. You can try again or use the navigation. {error.digest ? `Reference: ${error.digest}` : null}</p>
        <button className="btn btn-primary mt-4" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
