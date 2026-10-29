import { Select } from "@/components/ui/Select";
import { DISCUSSION_WINDOW_DAYS, discussionDownloaded } from "@/lib/sync/discussion-window";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { capabilitiesFor } from "@/lib/authz/viewer";
import { derivedDetail, getWorkItemDetail, asLabels, asStrings } from "@/lib/services/queries";
import { NotFoundError } from "@/lib/errors";
import { renderMarkdown } from "@/lib/markdown";
import { safeReturnTo } from "@/lib/http";
import { formatDuration, formatInstant } from "@/lib/format";
import { portForSync } from "@/lib/github/factory";
import { ActionForm } from "@/components/forms/ActionForm";
import { checkProfile } from "@/lib/local/identity";
import { Avatar, Banner, Segmented, DemoBadge, EmptyState, LabelChip, Mono, Panel, SimplePill, StatusPill, Time } from "@/components/ui/primitives";
import { ArrowLeft, Building2, CircleAlert, Eye, ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, CircleDot, Hourglass, MessageSquare, User } from "@/components/ui/icons";
import { assigneesAction, commentAction, labelsAction, manualWaitingAction, milestoneAction, requestReviewAction, resolveWaitingAction, submitReviewAction } from "@/app/actions";
import { MergeSheet } from "./MergeSheet";
import { ChecksCell } from "./WorkTable";

type Tab = "conversation" | "files" | "commits";

export async function WorkItemDetail({ id, tab, from }: { id: string; tab: Tab; from?: string }) {
  const { viewer } = await requireViewer();
  const now = new Date();
  let item;
  let derived;
  try {
    item = await getWorkItemDetail(db, viewer, id);
    derived = await derivedDetail(db, viewer, id, now);
  } catch (e) {
    if (e instanceof NotFoundError) notFound(); // same response for hidden and missing
    throw e;
  }
  const caps = await capabilitiesFor(db, viewer, item.repositoryId);
  const profile = item.repository.isDemo ? null : await checkProfile();
  const hasConnection = item.repository.isDemo || profile?.kind === "ok" || profile?.kind === "mismatch"; // writes always run as this profile's own account
  const labels = asLabels(item.labels);
  const d = derived.derivation;
  const isPr = item.type === "PULL_REQUEST";
  const backHref = from && safeReturnTo(from) !== "/" ? safeReturnTo(from) : isPr ? "/pull-requests" : "/issues";
  const base = isPr ? `/pull-requests/${item.id}` : `/issues/${item.id}`;
  const manualOpen = derived.manualWaiting;
  const writeBlocked = !hasConnection ? "Sign in with the GitHub CLI (gh auth login) to make changes on GitHub." : undefined;

  // Files/commits are fetched live and only on request; authorization was already decided above.
  let files: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof portForSync>>>["listPullFiles"]>> | null = null;
  let commits: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof portForSync>>>["listPullCommits"]>> | null = null;
  let liveError: string | null = null;
  if (isPr && (tab === "files" || tab === "commits")) {
    try {
      const port = await portForSync(db, item.repositoryId);
      if (!port) liveError = "No credential can read this repository right now.";
      else if (tab === "files") files = await port.listPullFiles(item.repository.owner.login, item.repository.name, item.number);
      else commits = await port.listPullCommits(item.repository.owner.login, item.repository.name, item.number);
    } catch (e) {
      liveError = e instanceof Error ? e.message : "GitHub could not be reached";
    }
  }

  const ownerLabel = item.repository.owner.type === "ORGANIZATION" ? "Organization" : item.repository.owner.type === "USER" ? "Personal account" : "Account type unknown";
  const comments = item.comments;

  return (
    <>
      <Link href={backHref} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink"><ArrowLeft size={14} aria-hidden /> Back to {isPr ? "pull requests" : "issues"}</Link>
      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 max-w-[80ch] text-[22px] font-medium leading-7 tracking-[-0.01em] [overflow-wrap:anywhere]">{item.title} <span className="font-normal text-ink-3 tnum">#{item.number}</span></h1>
          <a href={item.htmlUrl} target="_blank" rel="noopener noreferrer" className="btn"><ExternalLink size={14} aria-hidden /> Open on GitHub</a>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-3">
          <span className="inline-flex items-center gap-1">{isPr ? (item.state === "MERGED" ? <GitMerge size={14} aria-hidden /> : <GitPullRequest size={14} aria-hidden />) : <CircleDot size={14} aria-hidden />}<span className="capitalize">{item.draft ? "draft" : item.state.toLowerCase()}</span></span>
          <Mono title={item.repository.fullName}>{item.repository.fullName}</Mono>
          <span className="inline-flex items-center gap-1" title="From GitHub owner metadata">{item.repository.owner.type === "ORGANIZATION" ? <Building2 size={13} aria-hidden /> : <User size={13} aria-hidden />}{ownerLabel}</span>
          {item.authorLogin && <span className="inline-flex items-center gap-1.5"><Avatar login={item.authorLogin} url={item.authorAvatar} size={18} />{item.authorLogin}</span>}
          <span>opened <Time value={item.createdAtGh} formatted={formatInstant(item.createdAtGh, viewer.timezone)} /></span>
          {item.repository.isDemo && <DemoBadge />}
        </div>
        {labels.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{labels.map((l) => <LabelChip key={l.name} {...l} />)}</div>}
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          {isPr && (
            <Segmented label="Pull request sections" items={(["conversation", "files", "commits"] as const).map((t) => ({ href: `${base}?tab=${t}${from ? `&from=${encodeURIComponent(from)}` : ""}`, label: t[0].toUpperCase() + t.slice(1), active: tab === t }))} />
          )}

          {tab === "conversation" && (
            <>
              <Panel title="Description" icon={MessageSquare} id="desc">
                <div className="p-4">{item.body ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.body) }} /> : <p className="text-[13px] text-ink-3">No description.</p>}</div>
              </Panel>
              <Panel title={`Conversation (${comments.length})`} icon={MessageSquare} id="conv">
                {comments.length === 0 && !discussionDownloaded(item.state, item.updatedAtGh, new Date()) ? (
                  <EmptyState icon={MessageSquare} title="Conversation not downloaded">This item was closed more than {DISCUSSION_WINDOW_DAYS} days ago. To keep GitHub requests low, Mergeport downloads comments and reviews only for open and recently active items. That says nothing about whether the conversation was empty; open it on GitHub to read it.</EmptyState>
                ) : comments.length === 0 ? (
                  <EmptyState icon={MessageSquare} title="No comments or reviews yet">Comments, review submissions and inline review comments synchronized from GitHub appear here, labelled by kind.</EmptyState>
                ) : (
                  <ol className="flex flex-col">
                    {comments.map((c) => (
                      <li key={c.id} className="border-b border-line p-4 last:border-b-0">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px]">
                          {c.authorLogin && <Avatar login={c.authorLogin} size={18} />}
                          <span className="font-medium text-ink">{c.authorLogin ?? "unknown"}</span>
                          {c.kind === "REVIEW" && <SimplePill tone={c.reviewState === "APPROVED" ? "ok" : c.reviewState === "CHANGES_REQUESTED" ? "changes" : "unknown"} icon={Eye}>Review: {(c.reviewState ?? "commented").toLowerCase().replace("_", " ")}</SimplePill>}
                          {c.kind === "REVIEW_COMMENT" && <SimplePill tone="needs" icon={GitCommitHorizontal}>Inline{c.path ? ` · ${c.path}${c.line ? ":" + c.line : ""}` : ""}</SimplePill>}
                          {c.kind === "ISSUE_COMMENT" && <span className="text-ink-3">commented</span>}
                          <Time value={c.createdAtGh} formatted={formatInstant(c.createdAtGh, viewer.timezone)} />
                        </div>
                        {c.body ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} /> : <p className="text-[12.5px] text-ink-3">No text.</p>}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="border-t border-line p-4">
                  {caps.manageWork && !writeBlocked ? (
                    <ActionForm action={commentAction} submitLabel="Comment" pendingLabel="Posting…">
                      <input type="hidden" name="id" value={item.id} />
                      <label className="label" htmlFor="comment-body">Add a comment</label>
                      <textarea id="comment-body" name="body" className="textarea" required />
                    </ActionForm>
                  ) : (
                    <p className="text-[12.5px] text-ink-3">{writeBlocked ?? "Your grant for this repository does not include managing work, so commenting is unavailable."}</p>
                  )}
                </div>
              </Panel>
            </>
          )}

          {tab === "files" && (
            <Panel title={`Changed files${item.changedFiles != null ? ` (${item.changedFiles})` : ""}`} icon={GitCommitHorizontal} id="files">
              {liveError ? <div className="p-4"><Banner tone="error" title="Could not load the diff">{liveError}</Banner></div> : !files || files.files.length === 0 ? <EmptyState title="No file data available">GitHub returned no changed files.</EmptyState> : (
                <div>
                  {files.truncated && <div className="p-3"><Banner tone="warn" title="Showing the first 100 files">The pull request changes more files than are listed here. Open it on GitHub for the full diff.</Banner></div>}
                  {files.files.map((f) => (
                    <details key={f.filename} className="border-b border-line last:border-b-0" open={files!.files.length <= 3}>
                      <summary className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[13px]"><Mono title={f.filename}>{f.filename}</Mono><span className="ml-auto tnum text-ok">+{f.additions}</span><span className="tnum text-blocked">−{f.deletions}</span></summary>
                      {f.patch ? <pre className="mono overflow-x-auto border-t border-line bg-canvas p-3 text-[12px] leading-5">{f.patch.length > 20_000 ? f.patch.slice(0, 20_000) + "\n… truncated" : f.patch}</pre> : <p className="border-t border-line px-4 py-3 text-[12.5px] text-ink-3">No textual patch (binary or too large).</p>}
                    </details>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === "commits" && (
            <Panel title="Commits" icon={GitCommitHorizontal} id="commits">
              {liveError ? <div className="p-4"><Banner tone="error" title="Could not load commits">{liveError}</Banner></div> : !commits || commits.commits.length === 0 ? <EmptyState title="No commit data available" /> : (
                <ul>
                  {commits.truncated && <li className="p-3"><Banner tone="warn" title="Showing the first 100 commits" /></li>}
                  {commits.commits.map((c) => (
                    <li key={c.sha} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13px] last:border-b-0">
                      <Mono>{c.sha.slice(0, 7)}</Mono><span className="min-w-0 flex-1 truncate" title={c.message}>{c.message}</span><span className="text-ink-3">{c.author}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-5" aria-label="Review and actions">
          {isPr && (
            <Panel title="Review" icon={Eye} id="review">
              <div className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2"><StatusPill status={d.primary} />{d.waiting && <span className="tnum text-[12px] text-ink-3">waiting {formatDuration(d.waiting.elapsedMs)}</span>}</div>
                {d.applicable && d.actors.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {d.actors.map((a) => (
                      <li key={a.actor.kind + a.actor.ref} className="rounded-[10px] border border-line p-2.5 text-[12.5px]">
                        <div className="flex items-center justify-between gap-2"><span className="font-medium">{a.actor.display ?? a.actor.ref}<span className="ml-1.5 font-normal text-ink-3">{a.external ? "external" : "team"}</span></span><span className="text-ink-3">{a.status.replace("_", " ").toLowerCase()}</span></div>
                        <p className="mt-1 text-ink-3">{a.evidence}</p>
                        {a.since && <p className="mt-0.5 text-ink-3">since <Time value={a.since} formatted={formatInstant(a.since, viewer.timezone)} /> ({a.sinceBasis === "request" ? "review request first seen" : "became reviewable"})</p>}
                      </li>
                    ))}
                  </ul>
                )}
                {d.explanation.map((x) => <p key={x} className="text-[12.5px] text-ink-3">{x}</p>)}
                {derived.ruleConflict && <Banner tone="warn" title="Review rule conflict">{derived.ruleConflict}</Banner>}
                {d.blockedReasons.length > 0 && <Banner tone="error" title="Blocked">{d.blockedReasons.join(". ")}.</Banner>}
                <div className="flex items-center justify-between text-[12.5px]"><span className="text-ink-3">Checks</span><ChecksCell s={item.checksState} /></div>
                <p className="text-[11.5px] text-ink-3">Last synchronized <Time value={item.syncedAt} formatted={formatInstant(item.syncedAt, viewer.timezone)} />. Labels route attention; they never grant approval.</p>
              </div>
            </Panel>
          )}

          {isPr && item.state === "OPEN" && (
            <Panel title="Actions" icon={CircleAlert} id="actions">
              <div className="flex flex-col gap-4 p-4">
                {writeBlocked && <p className="text-[12.5px] text-ink-3">{writeBlocked}</p>}
                {caps.review && !writeBlocked ? (
                  <>
                    <ActionForm action={submitReviewAction} submitLabel="Submit review" pendingLabel="Submitting…">
                      <input type="hidden" name="id" value={item.id} />
                      <fieldset><legend className="label">Your review</legend>
                        <div className="flex flex-wrap gap-2">
                          {(["APPROVE", "COMMENT", "REQUEST_CHANGES"] as const).map((ev, i) => (
                            <label key={ev} className="btn cursor-pointer has-[:checked]:bg-ink has-[:checked]:text-ink-invert"><input type="radio" name="event" value={ev} defaultChecked={i === 1} className="sr-only" />{ev === "APPROVE" ? "Approve" : ev === "COMMENT" ? "Comment" : "Request changes"}</label>
                          ))}
                        </div>
                      </fieldset>
                      <label className="label mt-3" htmlFor="review-body">Summary</label>
                      <textarea id="review-body" name="body" className="textarea" />
                    </ActionForm>
                    <ActionForm action={requestReviewAction} submitLabel="Request review" pendingLabel="Requesting…" submitClassName="btn">
                      <input type="hidden" name="id" value={item.id} />
                      <label className="label" htmlFor="rr-users">GitHub usernames</label>
                      <input id="rr-users" name="users" className="input" placeholder="comma separated" />
                    </ActionForm>
                    <MergeSheet id={item.id} />
                  </>
                ) : !writeBlocked ? <p className="text-[12.5px] text-ink-3">Your grant does not include reviewing, so review and merge actions are unavailable.</p> : null}
              </div>
            </Panel>
          )}

          <Panel title="Details" icon={User} id="details">
            <div className="flex flex-col gap-4 p-4">
              {caps.manageWork && !writeBlocked ? (
                <>
                  <ActionForm action={labelsAction} submitLabel="Save labels" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={item.id} /><label className="label" htmlFor="d-labels">Labels</label><input id="d-labels" name="labels" className="input" defaultValue={labels.map((l) => l.name).join(", ")} /></ActionForm>
                  <ActionForm action={assigneesAction} submitLabel="Save assignees" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={item.id} /><label className="label" htmlFor="d-assign">Assignees</label><input id="d-assign" name="assignees" className="input" defaultValue={asStrings(item.assignees).join(", ")} /></ActionForm>
                  <ActionForm action={milestoneAction} submitLabel="Save milestone" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={item.id} /><label className="label" htmlFor="d-ms">Repository milestone number</label><input id="d-ms" name="number" inputMode="numeric" className="input" defaultValue={item.milestoneNumber ?? ""} placeholder={item.milestoneTitle ?? "none"} /></ActionForm>
                </>
              ) : (
                <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 text-[12.5px]"><dt className="text-ink-3">Assignees</dt><dd>{asStrings(item.assignees).join(", ") || "None"}</dd><dt className="text-ink-3">Milestone</dt><dd>{item.milestoneTitle ?? "None"}</dd></dl>
              )}
              {!caps.manageWork && <p className="text-[12px] text-ink-3">Editing needs a grant that includes managing work.</p>}
            </div>
          </Panel>

          <Panel title="Waiting on someone" icon={Hourglass} id="waiting">
            <div className="flex flex-col gap-3 p-4">
              {manualOpen.length === 0 && <p className="text-[12.5px] text-ink-3">No manual waiting record. {isPr ? "Pull requests derive this from review requests and rules." : "Use this when an issue needs another person's decision."}</p>}
              {manualOpen.map((w) => (
                <div key={w.id} className="rounded-[10px] border border-line p-2.5 text-[12.5px]">
                  <p className="font-medium">{w.reviewerRef} <span className="font-normal text-ink-3">· {w.reviewerKind === "EXTERNAL_ROLE" ? "external role" : "person"}</span></p>
                  <p className="text-ink-3">{w.reason}</p>
                  <p className="mt-0.5 text-ink-3">since <Time value={w.startedAt} formatted={formatInstant(w.startedAt, viewer.timezone)} /> · {formatDuration(now.getTime() - w.startedAt.getTime())}</p>
                  {(viewer.isAdmin || w.reviewerRef.toLowerCase() === viewer.login.toLowerCase()) && (
                    <ActionForm action={resolveWaitingAction} submitLabel="Mark decided" submitClassName="btn mt-2" className="mt-2">
                      <input type="hidden" name="id" value={w.id} /><input type="hidden" name="outcome" value="SATISFIED" />
                      <label className="label" htmlFor={`rw-${w.id}`}>Decision note</label><input id={`rw-${w.id}`} name="note" className="input" required />
                    </ActionForm>
                  )}
                </div>
              ))}
              {caps.manageWork && (
                <ActionForm action={manualWaitingAction} submitLabel="Mark as waiting" submitClassName="btn" pendingLabel="Saving…">
                  <input type="hidden" name="workItemId" value={item.id} />
                  <div className="flex flex-col gap-2">
                    <div><label className="label" htmlFor="mw-ref">Who needs to decide</label><input id="mw-ref" name="ref" className="input" required placeholder="GitHub username or role" /></div>
                    <div><label className="label" htmlFor="mw-kind">Kind</label><Select id="mw-kind" name="kind" className="select"><option value="USER">A GitHub person</option><option value="EXTERNAL_ROLE">An external role</option></Select></div>
                    <div><label className="label" htmlFor="mw-reason">Why</label><input id="mw-reason" name="reason" className="input" required /></div>
                  </div>
                  <p className="mt-2 text-[11.5px] text-ink-3">A dashboard record only. Nothing is posted to GitHub or sent to anyone.</p>
                </ActionForm>
              )}
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
