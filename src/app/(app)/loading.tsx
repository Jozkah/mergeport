/** Skeleton, not a centered spinner: the layout keeps its shape while data loads, and there is no entrance choreography. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton mb-2 h-8 w-64" />
      <div className="skeleton mb-6 h-4 w-96 max-w-full" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="panel">
            <div className="skeleton m-2 h-5 w-40" />
            <div className="panel-body p-4">
              <div className="skeleton h-9 w-16" />
              <div className="skeleton mt-3 h-4 w-48" />
            </div>
          </div>
        ))}
      </div>
      <div className="panel mt-5">
        <div className="skeleton m-2 h-5 w-48" />
        <div className="panel-body flex flex-col gap-3 p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
