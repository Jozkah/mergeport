import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { runUpdateNowAction, saveUpdateConfigAction } from "@/app/upstream-update-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Mono, SimplePill, Time } from "@/components/ui/primitives";
import { Ban, Check, CircleAlert, CircleDashed, ExternalLink, GitMerge, GitPullRequest, Hourglass, LoaderCircle } from "@/components/ui/icons";
import type { ComponentType, SVGProps } from "react";
import { formatInstant } from "@/lib/format";
import { getUpdateConfig, listUpdateRuns } from "@/lib/services/upstream-update";
import type { UpdateState } from "@/lib/domain/upstream-update";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
type Tone = "needs" | "waiting" | "changes" | "blocked" | "ok" | "unknown";
const STATE: Record<UpdateState, { tone: Tone; label: string; icon: Icon }> = {
  running: { tone: "needs", label: "Running", icon: LoaderCircle },
  "pr-opened": { tone: "needs", label: "Pull request open", icon: GitPullRequest },
  "merged-untested": { tone: "waiting", label: "Pull request open, not tested", icon: GitPullRequest },
  promoted: { tone: "ok", label: "Fork updated", icon: Check },
  "up-to-date": { tone: "ok", label: "Up to date", icon: Check },
  conflict: { tone: "changes", label: "Merge conflict", icon: CircleAlert },
  "verify-failed": { tone: "blocked", label: "Verification failed", icon: Ban },
  failed: { tone: "blocked", label: "Failed", icon: Ban },
  cancelled: { tone: "unknown", label: "Cancelled", icon: CircleDashed },
};

/**
 * Opt-in auto-update of one fork from its upstream. Says plainly what it runs and where; the controls are only shown to an administrator
 * (the verify command runs on this computer). The history is visible to everyone who can see the mapping.
 */
export async function UpstreamUpdate({ db, viewer, mappingId, forkBranch, forkName, upstreamName }: { db: Db; viewer: Viewer; mappingId: string; forkBranch: string; forkName: string; upstreamName: string }) {
  const [cfg, runs] = await Promise.all([getUpdateConfig(db, viewer, mappingId), listUpdateRuns(db, viewer, mappingId, 8)]);
  const canEdit = viewer.isAdmin;
  const id = (s: string) => `${s}-${mappingId}`;
  return (
    <section aria-labelledby={id("au")} className="rounded-[10px] border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id("au")} className="flex items-center gap-1.5 text-[13px] font-medium"><GitMerge size={13} aria-hidden /> Auto-update from upstream <SimplePill tone={cfg.enabled ? "ok" : "unknown"}>{cfg.enabled ? "On" : "Off"}</SimplePill></h3>
        {canEdit && cfg.enabled && <ActionForm action={runUpdateNowAction} submitLabel="Run now" pendingLabel="Queuing…" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="mappingId" value={mappingId} /></ActionForm>}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        When this fork falls behind <Mono>{upstreamName}</Mono>, Mergeport merges the newest upstream commit into a branch of its own, optionally checks it with a command, and then opens a pull request into <Mono>{forkBranch}</Mono>. If that commit conflicts or fails the check it tries the next older one (up to 6). It works only in a private copy under the <Mono>updater</Mono> folder of your Mergeport home: your own folders and branches are never touched, nothing is deleted, and upstream is never pushed to.
      </p>

      {canEdit ? (
        <ActionForm action={saveUpdateConfigAction} submitLabel="Save auto-update" resetOnSuccess={false} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="mappingId" value={mappingId} />
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="enabled" defaultChecked={cfg.enabled} /> Keep <Mono>{forkName}</Mono> up to date automatically</label>
          <div>
            <label className="label" htmlFor={id("vc")}>Check command (optional)</label>
            <input id={id("vc")} name="verifyCommand" className="input font-mono" defaultValue={cfg.verifyCommand} placeholder="npm test" autoComplete="off" spellCheck={false} />
            <p className="mt-1 text-[12px] text-ink-3">Runs on <strong>this computer</strong>, in the private copy, after a clean merge, with no shell, a minimal environment and your time limit. It is stored only in this profile&rsquo;s database: never shared with a team, a hub or a backup. Without one, the pull request is marked &ldquo;not tested&rdquo;. On Windows, <Mono>npm</Mono> and <Mono>npx</Mono> work; other tools installed as .cmd files do not (use <Mono>node script.js</Mono>).</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label" htmlFor={id("pm")}>When the merge is ready</label>
              <Select id={id("pm")} name="promote" className="select" defaultValue={cfg.promote}>
                <option value="pr">Open a pull request (recommended)</option>
                <option value="push">Push to {forkBranch} after the check (riskier)</option>
              </Select>
              <p className="mt-1 text-[12px] text-ink-3"><strong className="text-blocked">Push changes your fork branch on GitHub without anyone reviewing it.</strong> It is a plain fast-forward (never forced), only after the check passed, and needs a check command.</p>
            </div>
            <div>
              <label className="label" htmlFor={id("to")}>Check time limit (seconds)</label>
              <input id={id("to")} name="timeoutSec" inputMode="numeric" className="input w-32 tnum" defaultValue={cfg.timeoutSec} />
              <p className="mt-1 text-[12px] text-ink-3">10 to 7200. A check that runs longer is stopped and counts as failed.</p>
            </div>
          </div>
          <details className="text-[12.5px]">
            <summary className="cursor-pointer text-ink-2">Sync branch name</summary>
            <input id={id("bn")} name="branchName" className="input mt-1 w-72 font-mono" defaultValue={cfg.branchName} aria-label="Sync branch name" />
            <p className="mt-1 text-[12px] text-ink-3">The only branch Mergeport rewrites and pushes in pull request mode. It is replaced on every update, so do not work on it.</p>
          </details>
        </ActionForm>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">An administrator of this profile sets auto-update up, because its check command runs on this computer.</p>
      )}

      <h4 className="mt-4 text-[12.5px] font-medium">History</h4>
      {runs.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-3">{cfg.enabled ? "No run yet. One starts after the next comparison finds this fork behind." : "Nothing has run."}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5 text-[12.5px]">
          {runs.map((r, i) => {
            const s = STATE[r.state] ?? STATE.failed;
            return (
              <li key={r.id} className="rounded-[8px] border border-line">
                <details open={i === 0 && ["conflict", "verify-failed", "failed", "pr-opened", "merged-untested"].includes(r.state)}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-2">
                    <SimplePill tone={s.tone} icon={s.icon}>{s.label}</SimplePill>
                    <Time value={r.startedAt} formatted={formatInstant(r.startedAt, viewer.timezone)} />
                    {r.upstreamSha && <span className="text-ink-3">upstream <Mono>{r.upstreamSha.slice(0, 7)}</Mono></span>}
                    {r.tried.length > 1 && <span className="text-ink-3">{r.tried.length} commits tried</span>}
                    {r.trigger === "manual" && <span className="text-ink-3">started by you</span>}
                  </summary>
                  <div className="flex flex-col gap-2 border-t border-line p-2">
                    {r.error && <p className="text-blocked">{r.error}</p>}
                    {r.prUrl && <p><a className="inline-flex items-center gap-1 underline underline-offset-2" href={r.prUrl} target="_blank" rel="noreferrer noopener"><GitPullRequest size={12} aria-hidden /> Open the pull request <ExternalLink size={11} aria-hidden /></a></p>}
                    {r.state === "conflict" && (
                      <div>
                        <p className="font-medium">Files that conflict{r.files.length ? ` (${r.files.length})` : ""}</p>
                        <p className="text-ink-3">Nothing was changed on GitHub. Merge upstream yourself, or wait for a newer upstream commit.</p>
                        {r.files.length > 0 && <ul className="mt-1 list-disc pl-5">{r.files.map((f) => <li key={f}><Mono>{f}</Mono></li>)}</ul>}
                      </div>
                    )}
                    {r.commits.length > 0 && (
                      <div>
                        <p className="font-medium">Upstream commits in this update ({r.commits.length})</p>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {r.commits.map((c) => (
                            <li key={c.sha} className="flex flex-wrap items-baseline gap-x-2">
                              <a className="underline underline-offset-2" href={c.url} target="_blank" rel="noreferrer noopener"><Mono>{c.sha.slice(0, 7)}</Mono></a>
                              <span>{c.subject}</span>
                              <span className="text-ink-3">{c.author}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {r.tried.length > 1 && <p className="text-ink-3">Tried, newest first: {r.tried.map((t) => t.slice(0, 7)).join(", ")}</p>}
                    {r.logTail && (
                      <details>
                        <summary className="cursor-pointer text-ink-3"><span className="inline-flex items-center gap-1"><Hourglass size={11} aria-hidden /> Log (last lines)</span></summary>
                        <pre className="mono mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-canvas p-2 text-[12px]">{r.logTail}</pre>
                      </details>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
