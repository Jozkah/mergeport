"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-4 px-4 py-10">
      <div className="panel"><div className="panel-body p-6" role="alert">
        <h1 className="text-[20px] font-medium">Something went wrong</h1>
        <p className="mt-2 text-[13px] text-ink-3">The page could not be shown. Nothing was changed. {error.digest ? `Reference: ${error.digest}` : null}</p>
        <button className="btn btn-primary mt-4" onClick={reset}>Try again</button>
      </div></div>
    </main>
  );
}
