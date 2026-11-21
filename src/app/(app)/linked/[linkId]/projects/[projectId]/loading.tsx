import { BoardSkeleton } from "@/components/federation/LinkedBits";
import { PageHeader } from "@/components/ui/primitives";

/** Shown while the route itself resolves (the viewer, the link). The other instance's answer streams in behind its own skeleton. */
export default function Loading() {
  return (
    <>
      <div className="mb-3 flex justify-end" aria-hidden><div className="skeleton h-8 w-36 rounded-[8px]" /></div>
      <PageHeader title="Linked project" subtitle="Loading…" />
      <BoardSkeleton />
    </>
  );
}
