import { BoardSkeleton } from "@/components/federation/LinkedBits";
import { PageHeader } from "@/components/ui/primitives";

/** Shown while the route itself resolves (the viewer, the link). The other instance's answer streams in behind its own skeleton. */
export default function Loading() {
  return (
    <>
      <PageHeader title="Linked project" subtitle="Loading…" />
      <BoardSkeleton />
    </>
  );
}
