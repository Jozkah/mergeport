import Link from "next/link";
import { ctx } from "@/lib/ctx";
import type { ReactNode } from "react";
import { Ban, Check, CircleHelp, Clock, GitPullRequest, CircleDot, GitMerge } from "@/components/ui/icons";
import { Avatar, LabelChip, Mono, StatusPill, Time, DemoBadge } from "@/components/ui/primitives";
import { formatDuration, formatInstant } from "@/lib/format";
import type { ReviewDerivation } from "@/lib/domain/review";
import { asLabels, asStrings } from "@/lib/services/queries";

export type WorkRow = {
  id: string;
  number: number;
  type: "ISSUE" | "PULL_REQUEST";
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  authorLogin: string | null;
  authorAvatar: string | null;
  labels: unknown;
  assignees: unknown;
  milestoneTitle: string | null;
  checksState: "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN";
  updatedAtGh: Date;
  repository: { fullName: string; isDemo: boolean; owner: { type: "USER" | "ORGANIZATION" | "UNKNOWN" } };
};

export const itemHref = (r: { id: string; type: string }) => (r.type === "PULL_REQUEST" ? `/pull-requests/${r.id}` : `/issues/${r.id}`);

function StateIcon({ r }: { r: WorkRow }) {
  if (r.type === "ISSUE") return <CircleDot size={16} aria-hidden className={r.state === "OPEN" ? "text-ok" : "text-ink-3"} />;
  if (r.state === "MERGED") return <GitMerge size={16} aria-hidden className="text-ink-3" />;
  return <GitPullRequest size={16} aria-hidden className={r.state === "OPEN" ? "text-ok" : "text-ink-3"} />;
}

export function ChecksCell({ s }: { s: WorkRow["checksState"] }) {
  const m = {
    SUCCESS: { i: <Check size={14} aria-hidden />, t: "Passing", c: "text-ok" },
    FAILURE: { i: <Ban size={14} aria-hidden />, t: "Failing", c: "text-blocked" },
    PENDING: { i: <Clock size={14} aria-hidden />, t: "Running", c: "text-waiting" },
    UNKNOWN: { i: <CircleHelp size={14} aria-hidden />, t: "Unknown", c: "text-ink-3" },
    NONE: { i: null, t: "No checks", c: "text-ink-3" },
  }[s];
  return <span className={`inline-flex items-center gap-1 text-[12.5px] ${m.c}`}>{m.i}{m.t}</span>;
}

/** Contained horizontal scroll on narrow screens; first column keeps the item identity. */
export function WorkTable({ rows, derived, tz, now, showReview, empty }: { rows: WorkRow[]; derived?: Map<string, { derivation: ReviewDerivation; ruleConflict: string | null }>; tz: string; now: Date; showReview: boolean; empty: ReactNode }) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Results (scrolls horizontally on narrow screens)">
      <table className="data min-w-[760px]">
        <thead>
          <tr>
            <th scope="col" className="w-[44%]">Item</th>
            <th scope="col">Author</th>
            {showReview && <th scope="col">Review</th>}
            {showReview && <th scope="col">Checks</th>}
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = derived?.get(r.id);
            const labels = asLabels(r.labels);
            return (
              <tr key={r.id} data-ctx={ctx([{ label: "Open on GitHub", href: `https://github.com/${r.repository.fullName}/${r.type === "PULL_REQUEST" ? "pull" : "issues"}/${r.number}`, external: true }, { label: `Copy #${r.number}`, copy: `${r.repository.fullName}#${r.number}` }, { label: "Copy title", copy: r.title }, { label: "Copy GitHub link", copy: `https://github.com/${r.repository.fullName}/${r.type === "PULL_REQUEST" ? "pull" : "issues"}/${r.number}` }])}>
                <td>
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 shrink-0"><StateIcon r={r} /></span>
                    <div className="min-w-0">
                      <Link href={itemHref(r)} className="font-medium text-ink underline-offset-2 hover:underline">{r.title}</Link>
                      {r.draft && <span className="ml-2 align-middle text-[11.5px] text-ink-3">Draft</span>}
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                        <Mono title={r.repository.fullName}>{r.repository.fullName}#{r.number}</Mono>
                        <span>{r.type === "PULL_REQUEST" ? "Pull request" : "Issue"}{r.state !== "OPEN" ? ` · ${r.state.toLowerCase()}` : ""}</span>
                        {r.milestoneTitle && <span>· {r.milestoneTitle}</span>}
                        {r.repository.isDemo && <DemoBadge />}
                      </div>
                      {labels.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{labels.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  <div className="flex items-center gap-1.5">
                    {r.authorLogin ? <Avatar login={r.authorLogin} url={r.authorAvatar} size={20} /> : null}
                    <span className="truncate text-[12.5px]" title={r.authorLogin ?? undefined}>{r.authorLogin ?? "—"}</span>
                  </div>
                  {asStrings(r.assignees).length > 0 && <p className="mt-1 text-[11.5px] text-ink-3">Assigned: {asStrings(r.assignees).join(", ")}</p>}
                </td>
                {showReview && (
                  <td>
                    {r.type === "PULL_REQUEST" && r.state === "OPEN" && d ? (
                      <div className="flex flex-col items-start gap-1">
                        <StatusPill status={d.derivation.primary} />
                        {d.derivation.waiting && <span className="tnum text-[11.5px] text-ink-3">waiting {formatDuration(d.derivation.waiting.elapsedMs)}</span>}
                      </div>
                    ) : (
                      <span className="text-ink-3">{r.type === "PULL_REQUEST" ? r.state.toLowerCase() : "—"}</span>
                    )}
                  </td>
                )}
                {showReview && <td>{r.type === "PULL_REQUEST" ? <ChecksCell s={r.checksState} /> : <span className="text-ink-3">{"—"}</span>}</td>}
                <td><Time value={r.updatedAtGh} formatted={formatInstant(r.updatedAtGh, tz)} /><span className="sr-only"> ({formatDuration(now.getTime() - r.updatedAtGh.getTime())} ago)</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
