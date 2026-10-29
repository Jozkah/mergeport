import { ForkMapFields } from "@/components/forms/ForkMapFields";
import { WatchlistForm } from "@/components/forms/WatchlistForm";
import { UpstreamIssues } from "@/components/forks/UpstreamIssues";
import { UpstreamPrs } from "@/components/forks/UpstreamPrs";
import { byOwnerFirst } from "@/lib/domain/ordering";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { capabilitiesFor, repoWhere } from "@/lib/authz/viewer";
import { visibleForkMappings } from "@/lib/services/queries";
import { isComparisonStale } from "@/lib/domain/forks";
import { formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill, Time } from "@/components/ui/primitives";
import { ArrowRight, Eye, GitFork, GitCompare, RefreshCw } from "@/components/ui/icons";
import { mapForkAction, refreshForkAction, syncForkBranchAction } from "@/app/actions";

export const metadata = { title: "Forks" };

const STATUS = {
  identical: { tone: "ok", label: "Identical" },
  "fork-ahead": { tone: "needs", label: "Fork ahead" },
  "fork-behind": { tone: "waiting", label: "Fork behind upstream" },
  diverged: { tone: "changes", label: "Diverged" },
  unrelated: { tone: "unknown", label: "Unrelated histories" },
  unavailable: { tone: "blocked", label: "Unavailable" },
  unknown: { tone: "unknown", label: "Unknown" },
} as const;

export default async function Forks() {
  const { viewer } = await requireViewer();
  const mappings = await visibleForkMappings(db, viewer);
  const [forkRepos, allRepos, unmappedForks] = await Promise.all([
    db.repository.findMany({ where: repoWhere(viewer), orderBy: [{ isFork: "desc" }, { fullName: "asc" }], select: { id: true, fullName: true, defaultBranch: true, parentGithubId: true, parentFullName: true } }),
    db.repository.findMany({ where: repoWhere(viewer), select: { id: true, githubId: true, fullName: true, defaultBranch: true } }).then((rs) => rs.sort((a, b) => byOwnerFirst(viewer.login)(a.fullName, b.fullName))),
    db.repository.count({ where: { ...repoWhere(viewer), isFork: true, forkMappings: { none: { upstream: repoWhere(viewer) } } } }),
  ]);

  const detail = await Promise.all(
    mappings.map(async (m) => {
      const [prs, issues, caps, branches] = await Promise.all([
        db.upstreamPrState.findMany({ where: { mappingId: m.id }, orderBy: { number: "desc" } }),
        db.upstreamIssueTriage.findMany({ where: { mappingId: m.id }, orderBy: { issueNumber: "desc" } }),
        capabilitiesFor(db, viewer, m.forkRepoId),
        db.branch.findMany({ where: { repositoryId: { in: [m.forkRepoId, m.upstreamRepoId] } } }),
      ]);
      const forkTip = branches.find((b) => b.repositoryId === m.forkRepoId && b.name === m.forkBranch)?.sha ?? null;
      const upTip = branches.find((b) => b.repositoryId === m.upstreamRepoId && b.name === m.upstreamBranch)?.sha ?? null;
      return { m, prs, issues, caps, forkTip, upTip };
    }),
  );

  return (
    <>
      <PageHeader title="Forks" subtitle="Commit divergence, upstream pull requests and upstream issues are separate questions with separate evidence." />
      {unmappedForks > 0 && <div className="mb-4"><Banner title={`${unmappedForks} fork${unmappedForks === 1 ? "" : "s"} without a mapped upstream you can see`}>Upstream content is only shown when the upstream repository is also shared with you.</Banner></div>}

      {mappings.length === 0 ? (
        <Panel title="Forks" icon={GitFork}><EmptyState icon={GitFork} title="No tracked forks">{viewer.isAdmin ? "Paste repositories into the watchlist below, or map a fork to its upstream, to start comparing branches." : "An administrator has not mapped any fork you can see to an upstream you can see."}</EmptyState></Panel>
      ) : (
        <div className="flex flex-col gap-6">
          {detail.map(({ m, prs, issues, caps, forkTip, upTip }) => {
            const c = m.comparisons[0];
            const s = STATUS[(c?.status as keyof typeof STATUS) ?? "unknown"] ?? STATUS.unknown;
            const stale = c ? isComparisonStale({ baseSha: c.baseSha, headSha: c.headSha }, { upstreamTip: upTip, forkTip }) : true;
            const canSync = caps.manageWork && c && (c.status === "fork-behind" || c.status === "diverged" || c.status === "behind");
            return (
              <Panel key={m.id} id={`m-${m.id}`} icon={GitCompare} title={<span className="inline-flex flex-wrap items-center gap-2"><Mono>{m.fork.fullName}</Mono><ArrowRight size={12} aria-hidden /><Mono>{m.upstream.fullName}</Mono></span>}
                actions={<ActionForm action={refreshForkAction} submitLabel="Refresh" submitClassName="btn"><input type="hidden" name="mappingId" value={m.id} /></ActionForm>}>
                <div className="flex flex-col gap-5 p-4">
                  <div className="grid gap-4 md:grid-cols-[1fr_auto]">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2"><SimplePill tone={s.tone}>{s.label}</SimplePill>{c?.truncated && <SimplePill tone="unknown">Commit list truncated</SimplePill>}{stale && c && <SimplePill tone="waiting">Branch moved since this comparison</SimplePill>}</div>
                      <p className="text-[13px] text-ink-2">
                        Base <Mono>{m.upstream.name}:{m.upstreamBranch}</Mono> (upstream) · Head <Mono>{m.fork.name}:{m.forkBranch}</Mono> (fork)
                      </p>
                      {c ? (
                        <p className="tnum text-[13px]">
                          {c.aheadBy !== null ? <>Fork has <strong>{c.aheadBy}</strong> commit(s) upstream lacks. Fork is missing <strong>{c.behindBy}</strong> upstream commit(s).</> : <span className="text-ink-3">No counts available.</span>}
                        </p>
                      ) : <p className="text-[13px] text-ink-3">No comparison has run yet.</p>}
                      {c?.error && <p className="text-[12.5px] text-ink-3">{c.error}</p>}
                      {c && <p className="text-[12px] text-ink-3">Compared <Time value={c.comparedAt} formatted={formatInstant(c.comparedAt, viewer.timezone)} /> · upstream tip <Mono>{c.baseSha?.slice(0, 7) ?? "?"}</Mono> · fork tip <Mono>{c.headSha?.slice(0, 7) ?? "?"}</Mono></p>}
                    </div>
                    {canSync && forkTip && upTip && (
                      <Sheet title="Sync fork on GitHub" description="Only the fork on GitHub changes. No local worktree is touched." trigger={<button className="btn">Sync fork…</button>}>
                        <ActionForm action={syncForkBranchAction} submitLabel="Sync now" pendingLabel="Syncing…">
                          <input type="hidden" name="mappingId" value={m.id} /><input type="hidden" name="forkTip" value={forkTip} /><input type="hidden" name="upstreamTip" value={upTip} />
                          <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
                            <li>Brings <Mono>{m.fork.name}:{m.forkBranch}</Mono> up to date with <Mono>{m.upstream.fullName}:{m.upstreamBranch}</Mono>.</li>
                            <li>Branch heads are re-checked first; if either moved, nothing happens.</li>
                            <li>Conflicts are reported and nothing is forced, reset or force-pushed.</li>
                          </ul>
                        </ActionForm>
                      </Sheet>
                    )}
                  </div>

                  <section aria-labelledby={`prs-${m.id}`}>
                    <h3 id={`prs-${m.id}`} className="mb-2 text-[13px] font-medium">Upstream pull requests</h3>
                    <UpstreamPrs canEdit={caps.manageWork} rows={prs.map((p) => ({ id: p.id, number: p.number, title: p.title, url: p.htmlUrl, state: p.state, evidence: p.evidence, note: p.evidenceNote }))} />
                  </section>

                  <section aria-labelledby={`is-${m.id}`}>
                    <h3 id={`is-${m.id}`} className="mb-1 text-[13px] font-medium">Upstream issues to triage</h3>
                    <p className="mb-2 text-[12px] text-ink-3">Issues are discussions, not commits. Decide per fork whether each matters here. A status saves as soon as you pick it.</p>
                    <UpstreamIssues canEdit={caps.manageWork} rows={issues.map((i) => ({ id: i.id, number: i.issueNumber, title: i.title, url: i.htmlUrl, status: i.status, note: i.note }))} />
                  </section>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {viewer.isAdmin && (
        <div className="mt-6">
          <Panel title="Watchlist" icon={Eye} id="watchlist"><WatchlistForm /></Panel>
        </div>
      )}

      {viewer.isAdmin && forkRepos.length > 1 && (
        <div className="mt-6">
          <Panel title="Map a fork to its upstream" icon={GitFork} id="map">
            <div className="p-4">
              <ActionForm action={mapForkAction} submitLabel="Save mapping" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <ForkMapFields forks={forkRepos.map((r) => ({ id: r.id, fullName: r.fullName, parentGithubId: r.parentGithubId?.toString() ?? null, parentFullName: r.parentFullName }))} repos={allRepos.map((r) => ({ id: r.id, githubId: r.githubId.toString(), fullName: r.fullName }))} />
                <div><label className="label" htmlFor="mf-fb">Fork branch</label><input id="mf-fb" name="forkBranch" className="input" placeholder="default branch" /></div>
                <div><label className="label" htmlFor="mf-ub">Upstream branch</label><input id="mf-ub" name="upstreamBranch" className="input" placeholder="default branch" /></div>
              </ActionForm>
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3"><RefreshCw size={12} aria-hidden /> Default branches are discovered from GitHub, not assumed to be main. Leave a branch blank to use the repository default.</p>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
