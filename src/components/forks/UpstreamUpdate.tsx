import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { runUpdateNowAction, saveUpdateConfigAction } from "@/app/upstream-update-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { PromoteField } from "@/components/forks/PromoteField";
import { ReleasesSeen, UpdateModeFields } from "@/components/forks/UpdateModeFields";
import { Mono, SimplePill, Time } from "@/components/ui/primitives";
import { Ban, Check, ChevronDown, CircleAlert, CircleDashed, ExternalLink, GitMerge, GitPullRequest, LoaderCircle, Tag } from "@/components/ui/icons";
import type { ComponentType, SVGProps } from "react";
import { formatInstant } from "@/lib/format";
import { getUpdateConfig, listUpdateRuns } from "@/lib/services/upstream-update";
import type { ReleaseInfo, UpdateState } from "@/lib/domain/upstream-update";

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
  "release-found": { tone: "needs", label: "New release", icon: Tag },
};

/** Long lists and logs scroll inside their own box; the box is a keyboard stop so a keyboard user can scroll it too. */
const SCROLLBOX = "max-h-72 overflow-auto rounded-[8px] border border-line bg-canvas";

/**
 * Opt-in auto-update of one fork from its upstream. Says plainly what it runs and where; the controls are only shown to an administrator
 * (the verify command runs on this computer). The history is visible to everyone who can see the mapping.
 */
export async function UpstreamUpdate({ db, viewer, mappingId, forkBranch, forkName, upstreamName }: { db: Db; viewer: Viewer; mappingId: string; forkBranch: string; forkName: string; upstreamName: string }) {
  const [cfg, runs] = await Promise.all([getUpdateConfig(db, viewer, mappingId), listUpdateRuns(db, viewer, mappingId, 8)]);
  const canEdit = viewer.isAdmin;
  const watching = cfg.mode === "releases";
  const unseen = canEdit && runs.some((r) => r.state === "release-found" && !r.seenAt);
  const id = (s: string) => `${s}-${mappingId}`;
  return (
    <section aria-labelledby={id("au")} className="rounded-[10px] border border-line p-3 max-sm:rounded-none max-sm:border-0 max-sm:border-t max-sm:px-0 max-sm:pb-0 max-sm:pt-4 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id("au")} className="flex items-center gap-1.5 text-[13px] font-medium"><GitMerge size={13} aria-hidden /> Auto-update from upstream <SimplePill tone={cfg.enabled ? "ok" : "unknown"} icon={cfg.enabled ? Check : CircleDashed}>{cfg.enabled ? "On" : "Off"}</SimplePill></h3>
        {canEdit && cfg.enabled && <ActionForm action={runUpdateNowAction} submitLabel={watching ? "Check now" : "Run now"} submitAriaLabel={watching ? `Check now: releases of ${upstreamName}` : `Run now: update ${forkName}`} pendingLabel="Queuing…" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="mappingId" value={mappingId} /></ActionForm>}
      </div>
      <div className="mt-1 flex max-w-[72ch] flex-col gap-1 text-[12.5px] text-ink-3 text-pretty">
        {watching ? (
          <>
            <p>In this mode Mergeport only reads the releases of <Mono>{upstreamName}</Mono> from GitHub and tells you when a new one is published. It changes nothing: no copy of the repository, no merge, no branch, no pull request, no command.</p>
            {cfg.enabled && (
              <p className="tnum">
                {cfg.releasesBaselined ? <>Watching from <Mono>{cfg.lastReleaseTag ?? "the first release"}</Mono>, the newest release when the first check ran. </> : <>Not checked yet. The first check only notes the newest release; it does not warn about older ones. </>}
                {cfg.releasesCheckedAt && <>Last checked <Time value={cfg.releasesCheckedAt} formatted={formatInstant(cfg.releasesCheckedAt, viewer.timezone)} />.</>}
              </p>
            )}
          </>
        ) : (
          <>
            <p>When this fork falls behind <Mono>{upstreamName}</Mono>, Mergeport merges the newest upstream commit into a branch of its own, optionally checks it with a command, and then opens a pull request into <Mono>{forkBranch}</Mono>. If that commit conflicts or fails the check it tries the next older one (up to 6).</p>
            <p>It works only in a private copy under the <Mono>updater</Mono> folder of your Mergeport home: your own folders and branches are never touched, nothing is deleted, and upstream is never pushed to.</p>
          </>
        )}
      </div>

      {canEdit ? (
        <ActionForm action={saveUpdateConfigAction} submitLabel="Save auto-update" submitAriaLabel={`Save auto-update for ${forkName}`} resetOnSuccess={false} className="mt-3 flex flex-col gap-4">
          <input type="hidden" name="mappingId" value={mappingId} />
          <UpdateModeFields
            defaultMode={cfg.mode}
            enabled={cfg.enabled}
            forkName={forkName}
            upstreamName={upstreamName}
            mergeFields={
              <>
                <div>
                  <label className="label" htmlFor={id("vc")}>Check command (optional)</label>
                  <input id={id("vc")} name="verifyCommand" className="input font-mono" defaultValue={cfg.verifyCommand} placeholder="npm test" autoComplete="off" spellCheck={false} aria-describedby={id("vc-help")} />
                  <div id={id("vc-help")} className="mt-1 flex max-w-[72ch] flex-col gap-1 text-[12px] text-ink-3 text-pretty">
                    <p><strong className="font-medium text-ink-2">Runs on this computer</strong>, in the private copy, after a clean merge, with no shell, a minimal environment and your time limit. It is stored only in this profile&rsquo;s database: never shared with a team, a hub or a backup.</p>
                    <p>Without one, the pull request is marked &ldquo;not tested&rdquo;. On Windows, <Mono>npm</Mono> and <Mono>npx</Mono> work; other tools installed as .cmd files do not (use <Mono>node script.js</Mono>).</p>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <PromoteField id={id("pm")} name="promote" defaultValue={cfg.promote} forkBranch={forkBranch} />
                  <div>
                    <label className="label" htmlFor={id("to")}>Check time limit (seconds)</label>
                    <input id={id("to")} name="timeoutSec" inputMode="numeric" autoComplete="off" className="input w-32 tnum" defaultValue={cfg.timeoutSec} aria-describedby={id("to-help")} />
                    <p id={id("to-help")} className="mt-1 text-[12px] text-ink-3 text-pretty">10 to 7200. A check that runs longer is stopped and counts as failed.</p>
                  </div>
                </div>
                <details className="text-[12.5px]">
                  <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-1 text-ink-2"><ChevronDown size={14} aria-hidden className="chevron" /> Sync branch name</summary>
                  <input id={id("bn")} name="branchName" className="input w-full font-mono sm:w-72" defaultValue={cfg.branchName} aria-label="Sync branch name" aria-describedby={id("bn-help")} autoComplete="off" spellCheck={false} />
                  <p id={id("bn-help")} className="mt-1 max-w-[72ch] text-[12px] text-ink-3 text-pretty">The only branch Mergeport rewrites and pushes in pull request mode. It is replaced on every update, so do not work on it.</p>
                </details>
              </>
            }
            releaseFields={
              <>
                <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" name="includePrereleases" defaultChecked={cfg.includePrereleases} /> <span>Also warn about pre-releases</span></label>
                <p className="-mt-2 max-w-[72ch] text-[12px] text-ink-3 text-pretty">Drafts are never counted. The check command, merge mode, time limit and sync branch are not used here; what you stored for them is kept if you switch back.</p>
              </>
            }
          />
        </ActionForm>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">An administrator of this profile sets auto-update up, because its check command runs on this computer.</p>
      )}

      {unseen && <ReleasesSeen mappingId={mappingId} />}
      <h4 className="mt-5 text-[13px] font-medium">History</h4>
      {runs.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-3">{cfg.enabled ? (watching ? "No new release yet. A warning appears here when the upstream publishes one." : "No run yet. One starts after the next comparison finds this fork behind.") : "Nothing has run."}</p>
      ) : (
        <ul className="mt-1 divide-y divide-line rounded-[8px] border border-line text-[12.5px]">
          {runs.map((r, i) => {
            const s = STATE[r.state] ?? STATE.failed;
            const head = (
              <>
                <SimplePill tone={s.tone} icon={s.icon}>{s.label}</SimplePill>
                <Time value={r.startedAt} formatted={formatInstant(r.startedAt, viewer.timezone)} />
                {r.upstreamSha && <span className="tnum text-ink-3">upstream <Mono>{r.upstreamSha.slice(0, 7)}</Mono></span>}
                {r.tried.length > 1 && <span className="tnum text-ink-3">{r.tried.length} commits tried</span>}
                {r.release && <ReleaseHead release={r.release} fresh={!r.seenAt} />}
                {r.trigger === "manual" && <span className="text-ink-3">{r.release ? "found by your check" : "started by you"}</span>}
              </>
            );
            const headClass = "flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5";
            // A run with nothing more to say (running, up to date, cancelled) is a plain row: an expander that opens onto nothing is a trap.
            if (!r.error && !r.prUrl && !r.release && r.state !== "conflict" && r.commits.length === 0 && r.tried.length <= 1 && !r.logTail) return <li key={r.id} className={headClass}>{head}</li>;
            return (
              <li key={r.id}>
                <details open={i === 0 && ["conflict", "verify-failed", "failed", "pr-opened", "merged-untested", "release-found"].includes(r.state)}>
                  <summary className={`${headClass} cursor-pointer list-none`}>
                    {head}
                    <ChevronDown size={14} aria-hidden className="chevron ml-auto shrink-0 text-ink-3" />
                  </summary>
                  <div className="flex flex-col gap-3 border-t border-line p-2.5">
                    {r.error && <p className="text-blocked [overflow-wrap:anywhere] text-pretty">{r.error}</p>}
                    {r.release && <ReleaseBody release={r.release} timezone={viewer.timezone} upstreamName={upstreamName} forkBranch={forkBranch} />}
                    {r.prUrl && <p><a className="inline-flex min-h-10 items-center gap-1 underline underline-offset-2" href={r.prUrl} target="_blank" rel="noreferrer noopener"><GitPullRequest size={12} aria-hidden /> Open the pull request <ExternalLink size={11} aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a></p>}
                    {r.state === "conflict" && (
                      <div>
                        <p className="font-medium tnum">Files that conflict{r.files.length ? ` (${r.files.length})` : ""}</p>
                        <p className="text-ink-3 text-pretty">Nothing was changed on GitHub. Merge upstream yourself, or wait for a newer upstream commit.</p>
                        {r.files.length > 0 && <ul tabIndex={0} aria-label="Conflicting files" className={`mt-1 list-disc p-2 pl-7 ${SCROLLBOX}`}>{r.files.map((f) => <li key={f}><Mono>{f}</Mono></li>)}</ul>}
                      </div>
                    )}
                    {r.commits.length > 0 && (
                      <div>
                        <p className="font-medium tnum">Upstream commits in this update ({r.commits.length})</p>
                        <ul tabIndex={0} aria-label="Upstream commits in this update" className={`mt-1 flex flex-col p-1 ${SCROLLBOX}`}>
                          {r.commits.map((c) => (
                            <li key={c.sha}>
                              <a className="flex min-h-10 flex-wrap items-baseline gap-x-2 gap-y-0 rounded-[6px] px-1.5 py-1 hover:bg-subtle" href={c.url} target="_blank" rel="noreferrer noopener" aria-label={`Commit ${c.sha.slice(0, 7)}: ${c.subject}, by ${c.author} (opens in a new tab)`}>
                                <span className="underline underline-offset-2"><Mono>{c.sha.slice(0, 7)}</Mono></span>
                                <span className="min-w-0 [overflow-wrap:anywhere]">{c.subject}</span>
                                <span className="text-ink-3 [overflow-wrap:anywhere]">{c.author}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {r.tried.length > 1 && <p className="tnum text-ink-3 [overflow-wrap:anywhere]">Tried, newest first: {r.tried.map((t) => t.slice(0, 7)).join(", ")}</p>}
                    {r.logTail && (
                      <details>
                        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 text-ink-3"><ChevronDown size={14} aria-hidden className="chevron" /> Log (last lines)</summary>
                        <pre tabIndex={0} role="region" aria-label="Log, last lines" className="mono mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-canvas p-2 text-[12px] [overflow-wrap:anywhere]">{r.logTail}</pre>
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

/** The tag, and whether it is a pre-release or not looked at yet. The tag is untrusted text: rendered as text only. */
function ReleaseHead({ release, fresh }: { release: ReleaseInfo; fresh: boolean }) {
  return (
    <>
      <Mono>{release.tag}</Mono>
      {release.prerelease && <SimplePill tone="waiting">Pre-release</SimplePill>}
      {fresh && <SimplePill tone="needs">Not seen yet</SimplePill>}
    </>
  );
}

/** Everything here comes from the upstream's release page, so it is only ever shown as plain text; the one link is checked to point into the upstream repository. */
function ReleaseBody({ release, timezone, upstreamName, forkBranch }: { release: ReleaseInfo; timezone: string; upstreamName: string; forkBranch: string }) {
  const published = release.publishedAt ? new Date(release.publishedAt) : null;
  return (
    <div className="flex flex-col gap-2">
      {(release.name || published) && (
        <p className="tnum text-pretty [overflow-wrap:anywhere]">
          {release.name && release.name !== release.tag && <span className="font-medium">{release.name}</span>}
          {release.name && release.name !== release.tag && published && " · "}
          {published && <>Published <Time value={published} formatted={formatInstant(published, timezone)} /></>}
        </p>
      )}
      {release.inFork !== null && (
        <p className="text-ink-3 text-pretty">{release.inFork ? <>Your fork&rsquo;s <Mono>{forkBranch}</Mono> already contains this release&rsquo;s tag.</> : <>Your fork&rsquo;s <Mono>{forkBranch}</Mono> does not contain this release&rsquo;s tag yet.</>}</p>
      )}
      {release.notes && <p tabIndex={0} aria-label="Release notes (excerpt)" className={`whitespace-pre-wrap p-2 text-pretty [overflow-wrap:anywhere] ${SCROLLBOX}`}>{release.notes}</p>}
      {release.more > 0 && <p className="tnum text-ink-3 text-pretty">+{release.more} more new {release.more === 1 ? "release was" : "releases were"} published since the last check and {release.more === 1 ? "is" : "are"} not listed. See all releases of <Mono>{upstreamName}</Mono> on GitHub.</p>}
      {release.url && <p><a className="inline-flex min-h-10 items-center gap-1 underline underline-offset-2" href={release.url} target="_blank" rel="noreferrer noopener"><Tag size={12} aria-hidden /> Open the release on GitHub <ExternalLink size={11} aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a></p>}
    </div>
  );
}
