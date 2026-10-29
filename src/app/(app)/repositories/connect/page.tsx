import { byOwnerFirst } from "@/lib/domain/ordering";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { KEY_REPOS, cached, refreshing } from "@/lib/local/discovery-jobs";
import { ActionForm } from "@/components/forms/ActionForm";
import { Freshness } from "@/components/sync/Freshness";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { FolderGit2, Globe, Lock } from "@/components/ui/icons";
import { trackSelectedAction } from "@/app/actions";
import { describeAccess, describeOwner } from "@/lib/domain/repo-access";

export const metadata = { title: "Connect repositories" };
export const dynamic = "force-dynamic";

/**
 * Renders from the last known list in the local database. GitHub is asked in the background; the page says how old the
 * list is and, if the last attempt failed, why. A failed refresh never turns into an empty list.
 */
export default async function Connect() {
  const { viewer } = await requireViewer();
  const view = await cached.repos();
  const tracked = new Set((await db.repository.findMany({ where: { trackingStatus: { not: "REMOVED" } }, select: { githubId: true } })).map((r) => r.githubId.toString()));
  const repos = (view.payload?.repos ?? []).slice().sort((a, b) => byOwnerFirst(viewer.login)(a.fullName, b.fullName));
  const notes = view.payload?.notes ?? [];
  return (
    <>
      <PageHeader title="Connect repositories" subtitle="Lists only what your own GitHub account can enumerate. Tracking is local: it does not publish anything to teammates and does not change access on GitHub." />
      <div className="mb-4"><Freshness view={view} listKey={KEY_REPOS} timezone={viewer.timezone} refreshing={refreshing(KEY_REPOS)} /></div>
      {view.state === "AUTH" && <div className="mb-4"><Banner tone="error" title="GitHub sign-in needed">{view.error} The list below is the last one saved.</Banner></div>}
      {notes.map((n, i) => (
        <div key={i} className="mb-3"><Banner tone="warn" title={`${n.ownerLogin}: ${n.kind === "org-approval" ? "organization approval needed" : n.kind === "additional-authorization" ? "extra authorization needed" : "not listed"}`}>{n.message}{n.actionUrl ? <> <a className="underline" href={n.actionUrl} target="_blank" rel="noreferrer">Open on GitHub</a></> : null}</Banner></div>
      ))}
      <Panel title={`Available to you (${repos.length})`} icon={FolderGit2} id="available">
        {repos.length === 0 ? (
          <EmptyState icon={FolderGit2} title={view.fetchedAt ? "No repositories listed" : "No saved list yet"}>
            {view.fetchedAt ? "Your GitHub account listed no repositories when last checked. Public repositories can be added by URL on the Repositories page." : view.state === "EMPTY" || view.state === "RETRYING" ? "Asking GitHub in the background. This page stays usable meanwhile." : "GitHub has not been reachable yet, so nothing is saved. This is not an empty account: use Check again when you are online."}
          </EmptyState>
        ) : (
          <ActionForm action={trackSelectedAction} submitLabel="Track selected" pendingLabel="Tracking…" className="flex flex-col" success={{ link: { href: "/repositories", label: "Open Repositories" } }}>
            <ul className="max-h-[60vh] overflow-y-auto">
              {repos.map((r) => {
                const already = tracked.has(r.githubId.toString());
                const owner = describeOwner(r.owner.type, r.owner.login, viewer.login);
                const access = describeAccess(r.permissions);
                return (
                  <li key={r.githubId.toString()} className="border-b border-line last:border-b-0">
                    <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] hover:bg-faint has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                      <input type="checkbox" name="repo" value={r.githubId.toString()} disabled={already} />
                      <span className="min-w-0 flex-1 basis-[12rem] [overflow-wrap:anywhere]"><Mono>{r.fullName}</Mono></span>
                      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                        <span title={owner.detail}>{owner.label}</span>
                        <span title={access.detail} className={access.level === "read" || access.level === "unknown" ? "" : "text-ink-2"}>{access.label}</span>
                        {r.archived && <span title="Archived on GitHub: read only for everyone.">Archived</span>}
                        {r.isFork && <span title={r.parentFullName ? `Fork of ${r.parentFullName}` : "Fork"}>Fork</span>}
                        <span className="inline-flex items-center gap-1">{r.visibility === "PUBLIC" ? <Globe size={13} aria-hidden /> : <Lock size={13} aria-hidden />}{r.visibility.toLowerCase()}</span>
                      </span>
                      {already && <SimplePill tone="ok">Tracked</SimplePill>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </ActionForm>
        )}
      </Panel>
      <p className="mt-3 text-[12px] text-ink-3"><Link className="underline" href="/repositories">Back to repositories</Link></p>
    </>
  );
}
