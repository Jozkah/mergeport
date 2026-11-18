import type { ReactNode } from "react";
import type { Readiness, ReadinessState } from "@/lib/domain/readiness";
import { StatusMark, type StatusMarkState } from "@/components/ui/StatusMark";

const MARK: Record<ReadinessState, StatusMarkState> = { ok: "done", blocked: "failed", pending: "pending", unknown: "cancelled" };
const WORD: Record<ReadinessState, string> = { ok: "Good", blocked: "Blocked", pending: "Waiting", unknown: "Unknown" };
const SOURCE = { github: "from GitHub", dashboard: "dashboard advice", unknown: "not known here" } as const;

/**
 * Evidence for "can this merge, and who acts next". Unknown stays visibly unknown, and advice is labelled as advice.
 * `status` sits beside the verdict, `reviewers` replaces the Reviews row's name list with per-reviewer detail, and `notes` follow the list,
 * so review facts are shown once here instead of in a second panel.
 */
export function ReadinessPanel({ readiness, status, reviewers, notes, footer }: { readiness: Readiness; status?: ReactNode; reviewers?: ReactNode; notes?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="rounded-[10px] border border-line p-2.5 text-[12.5px]">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{readiness.ready ? "Ready to merge" : "Not ready yet"}</p>{status}</div>
        <p className="text-ink-2">Next: {readiness.nextAction}{readiness.nextBy.length > 0 && <span className="text-ink-3"> ({readiness.nextBy.join(", ")})</span>}</p>
      </div>
      <ul className="flex flex-col divide-y divide-line text-[12.5px]">
        {readiness.rows.map((r) => (
          <li key={r.key} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
            <StatusMark status={MARK[r.state]} size={16} ariaLabel={WORD[r.state]} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">{r.label} <span className="font-normal text-ink-3">· {WORD[r.state]}</span></p>
              {r.key === "reviews" && reviewers ? reviewers : <p className="text-ink-3">{r.evidence}</p>}
              <p className="text-[11.5px] text-ink-3">{SOURCE[r.source]}</p>
            </div>
          </li>
        ))}
      </ul>
      {notes}
      <p className="text-[11.5px] text-ink-3">Advice only. GitHub decides.{footer}</p>
    </div>
  );
}
