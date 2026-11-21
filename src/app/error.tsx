"use client";

import { useEffect } from "react";
import { AuthShell } from "@/components/ui/AuthShell";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <AuthShell title="Something went wrong">
      <div role="alert">
        <p className="mt-2 text-[13px] text-ink-3">The page could not be shown. Nothing was changed. If it keeps happening, reload the page or go back to the overview. {error.digest ? <>Reference: <span className="mono">{error.digest}</span></> : null}</p>
        <button type="button" className="btn btn-primary btn-lg mt-4 w-full" onClick={reset}>Try again</button>
      </div>
    </AuthShell>
  );
}
