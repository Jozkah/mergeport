export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading code" className="flex flex-col gap-3">
      <div className="h-8 w-72 animate-pulse rounded bg-muted" />
      <div className="overflow-hidden rounded-[6px] border border-line">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0"><div className="h-4 w-4 animate-pulse rounded bg-muted" /><div className="h-4 animate-pulse rounded bg-muted" style={{ width: `${20 + ((i * 29) % 40)}%` }} /></div>)}
      </div>
    </div>
  );
}
