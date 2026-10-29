import Link from "next/link";
import { byOwnerFirst } from "@/lib/domain/ordering";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere, viaRepo } from "@/lib/authz/viewer";
import { worktreesFor } from "@/lib/services/worktrees";
import { formatDuration, formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill, Time } from "@/components/ui/primitives";
import { GitBranch, Laptop, Lock } from "@/components/ui/icons";
import { mapRootAction, scanRootAction, unmapRootAction } from "@/app/actions";

export const metadata = { title: "Branches" };
export const dynamic = "force-dynamic";

export default async function Branches({ searchParams }: { searchParams: Promise<{ repo?: string; q?: string }> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const now = new Date();
  const repos = (await db.repository.findMany({ where: repoWhere(viewer), orderBy: { fullName: "asc" }, select: { id: true, fullName: true, owner: { select: { login: true } }, name: true } })).sort((a, b) => byOwnerFirst(viewer.login)(a.fullName, b.fullName));
  const [branches, openPrs] = await Promise.all([
    db.branch.findMany({ where: { ...viaRepo(viewer) }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    db.workItem.findMany({ where: { ...viaRepo(viewer), type: "PULL_REQUEST", state: "OPEN" }, select: { id: true, number: true, headRef: true, repositoryId: true, title: true } }),
  ]);
  // Repositories with a local folder come first; the rest wait behind "Show all" so the page stays light (each one is a full panel).
  const mappedIds = new Set((await db.deviceRepoMapping.findMany({ select: { repositoryId: true } })).map((m) => m.repositoryId));
  const ordered = [...repos.filter((r) => mappedIds.has(r.id)), ...repos.filter((r) => !mappedIds.has(r.id))];
  const needle = (sp.q ?? "").trim().toLowerCase();
  const listed = needle ? ordered.filter((r) => r.fullName.toLowerCase().includes(needle)) : ordered;
  const selected = ordered.find((r) => r.id === sp.repo) ?? listed[0] ?? ordered[0];
  const perRepo = selected ? [{ repo: selected, view: await worktreesFor(db, viewer, selected.id, now) }] : [];
  const branchCount = new Map<string, number>();
  for (const b of branches) branchCount.set(b.repositoryId, (branchCount.get(b.repositoryId) ?? 0) + 1);
  const href = (id: string) => `/branches?repo=${id}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  const prFor = (repoId: string, branch: string | null) => (branch ? openPrs.find((p) => p.repositoryId === repoId && p.headRef === branch) : undefined);

  return (
    <>
      <PageHeader title="Branches" subtitle="Remote branches come from GitHub. Local worktrees are read from folders you choose on this computer. Each list says which it is and how old it is." />
      <div className="mb-5"><Banner title="Read-only and private to this computer">Mergeport reads branch names, paths and counts of changed files with a fixed set of read-only git commands. It never reads file contents or diffs, never runs hooks or scripts from a repository, and never writes worktree data to a shared repository. There are no create, remove, reset or checkout controls.</Banner></div>

      <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <nav aria-label="Repositories" className="panel lg:sticky lg:top-3">
          <form method="get" action="/branches" className="px-2 pb-2 pt-1">
            <input name="q" defaultValue={sp.q ?? ""} className="input !h-8" placeholder="Search repositories" aria-label="Search repositories" />
          </form>
          <ul className="scroll-region !max-h-[calc(100dvh-16rem)] rounded-[9px] border border-edge bg-inset p-1">
            {listed.map((r) => (
              <li key={r.id}>
                <Link href={href(r.id)} aria-current={r.id === selected?.id ? "page" : undefined} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-hover aria-[current=page]:bg-nav-active aria-[current=page]:font-medium">
                  <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                  {mappedIds.has(r.id) && <Laptop size={12} aria-label="Has a local folder" className="shrink-0 text-ink-3" />}
                  <span className="tnum shrink-0 text-[11.5px] text-ink-3">{branchCount.get(r.id) ?? 0}</span>
                </Link>
              </li>
            ))}
            {listed.length === 0 && <li className="px-2 py-4 text-center text-[12.5px] text-ink-3">No repositories match.</li>}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-5">
        {perRepo.map(({ repo, view }) => {
          const rb = branches.filter((b) => b.repositoryId === repo.id);
          return (
            <Panel key={repo.id} id={`r-${repo.id}`} icon={GitBranch} title={<Mono>{repo.fullName}</Mono>}>
              <div className="grid gap-0 divide-y divide-line lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                <section className="min-w-0 p-4" aria-labelledby={`rb-${repo.id}`}>
                  <h3 id={`rb-${repo.id}`} className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-medium">Remote branches <SimplePill tone="unknown">Source: GitHub</SimplePill></h3>
                  {rb.length === 0 ? <p className="text-[12.5px] text-ink-3">No branches synchronized yet.</p> : (
                    <ul className="scroll-region !max-h-80 flex flex-col gap-1.5 pr-1 text-[13px]">
                      {rb.map((b) => <li key={b.id} className="flex items-center justify-between gap-2"><span className="min-w-0 truncate" title={b.name}><Mono>{b.name}</Mono>{b.isDefault && <span className="ml-2 text-[11.5px] text-ink-3">default</span>}</span><Mono title={b.sha}>{b.sha.slice(0, 7)}</Mono></li>)}
                    </ul>
                  )}
                  {rb[0] && <p className="mt-2 text-[11.5px] text-ink-3">Fetched {formatDuration(now.getTime() - rb[0].fetchedAt.getTime())} ago.</p>}
                </section>

                <section className="min-w-0 p-4" aria-labelledby={`wt-${repo.id}`}>
                  <h3 id={`wt-${repo.id}`} className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-medium">Local worktrees <SimplePill tone="unknown">Source: this computer</SimplePill></h3>
                  {view ? (
                    <div className="mb-3">
                      <p className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                        <Laptop size={13} aria-hidden />{view.machine}
                        {view.capturedAt.getTime() > 0 ? <> · scanned <Time value={view.capturedAt} formatted={formatInstant(view.capturedAt, viewer.timezone)} /></> : " · not scanned yet"}
                        {view.stale && <SimplePill tone="waiting">Stale: scan again</SimplePill>}
                      </p>
                      {view.rootPath && <p className="mt-1 text-[12px] text-ink-3">Folder <Mono>{view.rootPath}</Mono></p>}
                      <ul className="mt-1.5 flex flex-col gap-2">
                        {view.worktrees.map((t, j) => {
                          const pr = prFor(repo.id, t.branch);
                          return (
                            <li key={j} className="rounded-[10px] border border-line p-2.5 text-[12.5px]">
                              <div className="flex flex-wrap items-center gap-2">
                                {"path" in t && t.path ? <Mono title={t.path as string}>{t.path as string}</Mono> : <span className="inline-flex items-center gap-1 text-ink-3"><Lock size={12} aria-hidden /> Path hidden</span>}
                                {t.detached ? <SimplePill tone="waiting">Detached HEAD</SimplePill> : <Mono>{t.branch}</Mono>}
                                {t.locked && <SimplePill tone="unknown">Locked</SimplePill>}
                                {t.prunable && <SimplePill tone="changes">Prunable</SimplePill>}
                                {t.missing && <SimplePill tone="blocked">Path missing</SimplePill>}
                                {t.dirty ? (t.dirty.staged + t.dirty.unstaged + t.dirty.untracked + t.dirty.conflicted > 0 ? <SimplePill tone="changes">Dirty: {t.dirty.staged} staged, {t.dirty.unstaged} modified, {t.dirty.untracked} untracked{t.dirty.conflicted ? `, ${t.dirty.conflicted} conflicted` : ""}</SimplePill> : <SimplePill tone="ok">Clean</SimplePill>) : <SimplePill tone="unknown">Status not reported</SimplePill>}
                              </div>
                              <p className="mt-1 text-ink-3">{t.head ? <>HEAD <Mono>{t.head.slice(0, 7)}</Mono></> : "No HEAD"}{t.tracking?.upstream ? <> · tracks <Mono>{t.tracking.upstream}</Mono>, ahead {t.tracking.ahead ?? "?"} / behind {t.tracking.behind ?? "?"} as of the last fetch (remote may have moved)</> : " · no upstream"}</p>
                              {pr && <p className="mt-1 text-ink-3">Possibly PR #{pr.number}: head branch name matches (name-based, not verified).</p>}
                            </li>
                          );
                        })}
                      </ul>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <ActionForm action={scanRootAction} submitLabel="Scan again" pendingLabel="Scanning…" submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="repositoryId" value={repo.id} /></ActionForm>
                        <ActionForm action={unmapRootAction} submitLabel="Forget folder" submitClassName="btn btn-danger" resetOnSuccess={false}><input type="hidden" name="repositoryId" value={repo.id} /></ActionForm>
                      </div>
                    </div>
                  ) : (
                    <ActionForm action={mapRootAction} submitLabel="Map and scan" pendingLabel="Scanning…" submitClassName="btn" className="flex flex-col gap-1.5">
                      <input type="hidden" name="repositoryId" value={repo.id} />
                      <label className="label" htmlFor={`root-${repo.id}`}>Folder of this repository on this computer</label>
                      <input id={`root-${repo.id}`} name="path" className="input" placeholder="C:\code\my-repo" required autoComplete="off" spellCheck={false} />
                      <p className="text-[12px] text-ink-3">The path stays on this computer. It is never stored in a coordination repository.</p>
                    </ActionForm>
                  )}
                </section>
              </div>
            </Panel>
          );
        })}
        </div>
        {repos.length === 0 && <Panel title="Branches" icon={GitBranch}><EmptyState icon={GitBranch} title="No repositories to show" action={<Link href="/repositories/connect" className="btn btn-primary">Connect repositories</Link>}>Connect a repository and its branches appear here.</EmptyState></Panel>}
      </div>
    </>
  );
}
