import type { Scope } from "@/lib/scope";
import { scopeLabel } from "@/lib/scope";

/** Says what this page is currently narrowed to, so a short list is never mistaken for a quiet team. */
export function ScopeNote({ scope }: { scope: Scope }) {
  if (scope.kind === "all") return null;
  return (
    <p className="mb-3 text-[12.5px] text-ink-3" role="status">
      Showing only <span className="font-medium text-ink-2">{scopeLabel(scope)}</span>. Change the scope in the top bar to see everything.
    </p>
  );
}
