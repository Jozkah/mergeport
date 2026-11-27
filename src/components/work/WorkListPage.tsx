import { Select } from "@/components/ui/Select";
import { byOwnerFirst } from "@/lib/domain/ordering";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { deriveForIds, listProjects, listWorkItemAuthors, listWorkItems, writableRepos, REPO_KINDS, REPO_PERMISSION_LEVELS, type RepoKind, type RepoPermissionLevel, type WorkItemListParams } from "@/lib/services/queries";
import { readScope, scopeRepositoryIds } from "@/lib/scope";
import { ViewBar } from "@/components/views/ViewBar";
import { listViews } from "@/lib/services/views";
import { ScopeNote } from "@/components/shell/ScopeNote";
import { PageHeader, Panel, EmptyState, Segmented, Banner, Avatar } from "@/components/ui/primitives";
import { CircleDot, Filter, GitPullRequest, Plus, Search } from "@/components/ui/icons";
import { WorkTable } from "./WorkTable";
import { ActionForm } from "@/components/forms/ActionForm";
import { deleteFilterAction, saveFilterAction } from "@/app/actions";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
/** Every value of a repeatable parameter (multi-select filters submit `authors=a&authors=b`). */
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const pick = <T extends string>(allowed: readonly T[], v: string | string[] | undefined) => [...new Set(many(v))].filter((x): x is T => (allowed as readonly string[]).includes(x));
const MULTI = new Set(["authors", "kind", "perm"]);
const KIND_LABEL: Record<RepoKind, string> = { private: "Private", fork: "Forks", shared: "Shared" };
const PERM_LABEL: Record<RepoPermissionLevel, string> = { read: "Read only", write: "Write", admin: "Admin" };

/** A group of checkboxes inside the filter form: native inputs, so it works without JavaScript and by keyboard. */
function CheckGroup({ legend, name, options, selected, scroll }: { legend: string; name: string; options: { value: string; label: string; avatar?: string | null }[]; selected: string[]; scroll?: boolean }) {
  return (
    <fieldset className="min-w-0">
      <legend className="label">{legend}</legend>
      <div className={scroll ? "flex max-h-56 w-full flex-col overflow-y-auto rounded-[8px] border border-line px-2 sm:w-[240px]" : "flex flex-wrap gap-x-3"}>
        {options.map((o) => (
          <label key={o.value} className="check-row text-[13px]">
            <input type="checkbox" name={name} value={o.value} defaultChecked={selected.includes(o.value)} />
            {o.avatar !== undefined && <Avatar login={o.label} url={o.avatar} size={18} />}
            <span className="min-w-0 truncate">{o.label}</span>
          </label>
        ))}
        {options.length === 0 && <span className="py-2 text-[12.5px] text-ink-3">No authors yet.</span>}
      </div>
    </fieldset>
  );
}

export async function WorkListPage({ type, searchParams }: { type: "ISSUE" | "PULL_REQUEST"; searchParams: SP }) {
  const { viewer, user } = await requireViewer();
  const now = new Date();
  const state = (["OPEN", "CLOSED", "MERGED", "ALL"].includes(one(searchParams.state).toUpperCase()) ? one(searchParams.state).toUpperCase() : "OPEN") as WorkItemListParams["state"];
  const scope = await readScope(db, viewer);
  const scopedRepos = !one(searchParams.repo) ? await scopeRepositoryIds(db, scope) : undefined;
  const authors = [...new Set(many(searchParams.authors))].slice(0, 50);
  const repoKinds = pick(REPO_KINDS, searchParams.kind);
  const permissions = pick(REPO_PERMISSION_LEVELS, searchParams.perm);
  const params: WorkItemListParams = {
    type,
    state,
    repositoryIds: one(searchParams.repo) ? [one(searchParams.repo)] : scopedRepos,
    projectId: one(searchParams.project) || undefined,
    label: one(searchParams.label) || undefined,
    author: one(searchParams.author) || undefined, // older free-text links and saved filters; its box shows only while set
    authors,
    repoKinds,
    permissions,
    assignee: one(searchParams.assignee) || undefined,
    q: one(searchParams.q) || undefined,
    sort: (["updated", "created", "number", "title"].includes(one(searchParams.sort)) ? one(searchParams.sort) : "updated") as WorkItemListParams["sort"],
    dir: one(searchParams.dir) === "asc" ? "asc" : "desc",
    page: Number(one(searchParams.page)) || 1,
    pageSize: 25,
  };
  const [list, reposRaw, projects, saved, writable, authorRows] = await Promise.all([
    listWorkItems(db, viewer, params),
    db.repository.findMany({ where: repoWhere(viewer), select: { id: true, fullName: true, isDemo: true }, orderBy: { fullName: "asc" } }),
    listProjects(db, viewer),
    db.savedFilter.findMany({ where: { userId: user.id, scope: type } }),
    writableRepos(db, viewer),
    listWorkItemAuthors(db, viewer, type),
  ]);
  // A chosen author stays listed (and can be unticked) even when it falls outside the first page of names.
  const authorOptions = [...authorRows, ...authors.filter((a) => !authorRows.some((r) => r.login.toLowerCase() === a.toLowerCase())).map((login) => ({ login, avatarUrl: null }))];
  const derived = type === "PULL_REQUEST" ? await deriveForIds(db, viewer, list.rows.map((r) => r.id), now, params.projectId) : undefined;

  const base = type === "PULL_REQUEST" ? "/pull-requests" : "/issues";
  const qs = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) if (!(k in over)) for (const x of MULTI.has(k) ? many(v) : [one(v)]) if (x) u.append(k, x);
    for (const [k, v] of Object.entries(over)) if (v) u.set(k, v);
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  const repos = [...reposRaw].sort((a, b) => byOwnerFirst(viewer.login)(a.fullName, b.fullName));
  const currentQuery = qs({ page: undefined }).replace(/^\?/, "");
  const moreActive = Boolean(params.projectId || params.label || params.author || authors.length || repoKinds.length || permissions.length || one(searchParams.sort));
  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const to = Math.min(list.total, list.page * list.pageSize);
  const Icon = type === "PULL_REQUEST" ? GitPullRequest : CircleDot;
  const title = type === "PULL_REQUEST" ? "Pull requests" : "Issues";
  const unsynced = repos.length > 0 ? await db.repository.count({ where: { ...repoWhere(viewer), lastSyncedAt: null, isDemo: false, trackingStatus: { not: "REMOVED" } } }) : 0;
  const stale = repos.length > 0 ? await db.repository.count({ where: { ...repoWhere(viewer), OR: [{ rateLimited: true }, { trackingStatus: "DISCONNECTED" }, { syncError: { not: null } }] } }) : 0;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={`Across ${repos.length} repositor${repos.length === 1 ? "y" : "ies"} you can see. Counts include only what you have access to.`}
        actions={
          type === "ISSUE" && writable.length > 0 ? (
            <Link href="/issues/new" className="btn btn-primary"><Plus size={14} aria-hidden /> New issue</Link>
          ) : undefined
        }
      />
      <ScopeNote scope={scope} />
      <ViewBar scope={type} views={await listViews(db, viewer, type)} />
      {unsynced > 0 && (
        <div className="mb-4">
          <Banner tone="info" title={`${unsynced} of ${repos.length} repositor${repos.length === 1 ? "y has" : "ies have"} not been synchronized yet`}>
            Their {type === "PULL_REQUEST" ? "pull requests" : "issues"} are not in this list yet. That means unknown, not zero. The top bar shows refresh progress.
          </Banner>
        </div>
      )}
      {stale > 0 && (
        <div className="mb-4">
          <Banner tone="warn" title={`${stale} repositor${stale === 1 ? "y has" : "ies have"} stale or limited data`}>
            Results may be out of date. Open Repositories to see each one&apos;s sync status.
          </Banner>
        </div>
      )}
      <Panel title={title} icon={Icon} id="list" actions={<Segmented label="State" items={(type === "PULL_REQUEST" ? (["OPEN", "MERGED", "CLOSED", "ALL"] as const) : (["OPEN", "CLOSED", "ALL"] as const)).map((s) => ({ href: `${base}${qs({ state: s === "OPEN" ? undefined : s, page: undefined })}`, label: s === "ALL" ? "All" : s[0] + s.slice(1).toLowerCase(), active: state === s }))} />}>
        <form method="get" action={base} className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <div className="min-w-[200px] flex-1">
            <label className="label" htmlFor="f-q">Search titles or number</label>
            <div className="relative"><Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-[9px] text-ink-3" /><input id="f-q" name="q" defaultValue={params.q} className="input !pl-8" placeholder="e.g. pagination or 14" /></div>
          </div>
          <div className="w-[190px]"><label className="label" htmlFor="f-repo">Repository</label><Select id="f-repo" name="repo" defaultValue={one(searchParams.repo)} className="select"><option value="">All visible</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
          <input type="hidden" name="state" value={state === "OPEN" ? "" : state} />
          <button className="btn"><Filter size={14} aria-hidden /> Apply</button>
          {currentQuery && <Link href={base} className="btn btn-quiet">Clear</Link>}
          <details open={moreActive} className="w-full">
            <summary className="btn btn-quiet inline-flex cursor-pointer list-none">More filters{moreActive ? " (active)" : ""}</summary>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="w-[150px]"><label className="label" htmlFor="f-project">Project</label><Select id="f-project" name="project" defaultValue={one(searchParams.project)} className="select"><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
              <div className="w-[140px]"><label className="label" htmlFor="f-label">Label</label><input id="f-label" name="label" defaultValue={params.label} className="input" /></div>
              {params.author && <div className="w-[130px]"><label className="label" htmlFor="f-author">Author contains</label><input id="f-author" name="author" defaultValue={params.author} className="input" /></div>}
              <div className="w-[140px]"><label className="label" htmlFor="f-sort">Sort</label><Select id="f-sort" name="sort" defaultValue={params.sort} className="select"><option value="updated">Recently updated</option><option value="created">Newest</option><option value="number">Number</option><option value="title">Title</option></Select></div>
            </div>
            <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3">
              <CheckGroup legend="Authors" name="authors" scroll selected={authors} options={authorOptions.map((a) => ({ value: a.login, label: a.login, avatar: a.avatarUrl }))} />
              <CheckGroup legend="Repository kind" name="kind" selected={repoKinds} options={REPO_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
              <CheckGroup legend="Your permission" name="perm" selected={permissions} options={REPO_PERMISSION_LEVELS.map((k) => ({ value: k, label: PERM_LABEL[k] }))} />
            </div>
          </details>
        </form>
        {(saved.length > 0 || currentQuery) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
            <span className="text-ink-3">Saved filters</span>
            {saved.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1">
                <Link href={`${base}?${s.query}`} className="btn !h-7">{s.name}</Link>
                <ActionForm action={deleteFilterAction} submitLabel="Remove" submitClassName="btn btn-quiet !h-7 !px-2 text-ink-3"><input type="hidden" name="id" value={s.id} /></ActionForm>
              </span>
            ))}
            {currentQuery && (
              <ActionForm action={saveFilterAction} submitLabel="Save current" submitClassName="btn !h-7" className="ml-auto flex items-center gap-2">
                <label className="sr-only" htmlFor="sf-name">Filter name</label>
                <input id="sf-name" name="name" className="input !h-7 !w-36" placeholder="Name this filter" required />
                <input type="hidden" name="scope" value={type} /><input type="hidden" name="query" value={currentQuery} />
              </ActionForm>
            )}
          </div>
        )}
        <WorkTable
          rows={list.rows}
          derived={derived}
          tz={viewer.timezone}
          now={now}
          showReview={type === "PULL_REQUEST"}
          showType={false}
          showDemo={false}
          empty={
            <EmptyState icon={Icon} title={repos.length === 0 ? "No repositories yet" : "Nothing matches these filters"}>
              {repos.length === 0 ? "You have no repositories assigned. Ask an administrator for access, or connect your own from Repositories." : "Try clearing a filter. Only work in repositories you can access is searched."}
            </EmptyState>
          }
        />
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-[12.5px] text-ink-3">
          <span className="tnum">{from}–{to} of {list.total} <span className="sr-only">visible to you</span></span>
          <nav aria-label="Pagination" className="flex items-center gap-2">
            {list.page > 1 ? <Link className="btn" href={`${base}${qs({ page: String(list.page - 1) })}`}>Previous</Link> : <span className="btn" aria-disabled>Previous</span>}
            {to < list.total ? <Link className="btn" href={`${base}${qs({ page: String(list.page + 1) })}`}>Next</Link> : <span className="btn" aria-disabled>Next</span>}
          </nav>
        </div>
      </Panel>
    </>
  );
}
