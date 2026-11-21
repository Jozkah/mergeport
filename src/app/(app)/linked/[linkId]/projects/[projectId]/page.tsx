import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/authz-page";
import { db } from "@/lib/db";
import { AutoRefresh } from "@/components/federation/AutoRefresh";
import { BoardSkeleton } from "@/components/federation/LinkedBits";
import { Banner, EmptyState, PageHeader, Panel, Segmented } from "@/components/ui/primitives";
import { CalendarDays, Globe } from "@/components/ui/icons";
import { formatDateOnly, formatInstant } from "@/lib/format";
import { liveCtx, type FedCtx } from "@/lib/federation/context";
import { remoteGet, type Remote } from "@/lib/federation/consumer";
import type { BoardDto, TaskDto } from "@/lib/federation/read-api";
import type { Viewer } from "@/lib/authz/viewer";

export const metadata = { title: "Linked project" };
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,60}$/;

const backToLinked = <Link href="/linked" className="btn shrink-0">Back to linked</Link>;

/** Revoked / error / switched-off answers: said once, with a way out. */
function StateBanner({ r }: { r: Remote<unknown> }) {
  if (r.state === "ok") return null;
  return (
    <Banner tone={r.state === "blocked" ? "warn" : "error"} title={r.state === "revoked" ? "Access was revoked" : r.state === "blocked" ? "Linking is switched off" : "Could not load this project"} action={backToLinked}>
      {r.error}
    </Banner>
  );
}

/** The streamed part: the other instance is asked here, inside Suspense, so the header and toggle paint first. */
async function ProjectBody({ ctx, viewer, linkId, projectId, peer, list }: { ctx: FedCtx; viewer: Viewer; linkId: string; projectId: string; peer: string; list: boolean }) {
  const board = list ? null : await remoteGet<BoardDto>(ctx, viewer, linkId, `/projects/${projectId}`, { background: true });
  const tasks = list ? await remoteGet<{ tasks: TaskDto[]; nextCursor: string | null }>(ctx, viewer, linkId, `/projects/${projectId}/tasks?limit=100`, { background: true }) : null;
  const r = board ?? tasks!;
  const shown = board?.data ? board.data.columns.reduce((n, c) => n + c.items.length, 0) : 0;
  return (
    <>
      <Banner tone="info" title={`Read-only view of ${peer}. Nothing is copied here.`}>
        {board?.data ? <span className="wrap-any font-medium text-ink-2">{board.data.project.name}. </span> : null}
        {r.fetchedAt ? <>Last updated <span className="tnum">{formatInstant(r.fetchedAt, viewer.timezone)}</span>{r.stale ? " (refreshing)" : ""}.</> : null}
      </Banner>
      <StateBanner r={r} />
      {board?.data && board.data.columns.length === 0 && <EmptyState icon={Globe} title="No columns">This project has no board yet.</EmptyState>}
      {board?.data && board.data.columns.length > 0 && (
        <div className="linked-board" tabIndex={0} role="region" aria-label="Board, scrolls sideways">
          {board.data.columns.map((c) => (
            <Panel key={c.key} title={<>{c.name} <span className="tnum font-normal text-ink-3">{c.items.length}</span></>} collapsible={false}>
              <ul className="flex flex-col gap-2 p-2">
                {c.items.map((i) => (
                  <li key={i.id} className="rounded-[10px] border border-line bg-surface p-3 text-[13px] shadow-hair">
                    <p className="wrap-any font-medium leading-[1.35]">{i.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
                      {i.priority > 0 && <span className="tnum">P{i.priority}</span>}
                      {i.dueDate && <span className="inline-flex items-center gap-1 tnum"><CalendarDays size={12} aria-hidden />Due {formatDateOnly(new Date(`${i.dueDate}T00:00:00Z`))}</span>}
                      {i.assignee && <span className="break-all"><bdi>@{i.assignee}</bdi></span>}
                      {i.labels.slice(0, 3).map((l) => <span key={l} className="chip" title={l}><span className="truncate">{l}</span></span>)}
                      {i.labels.length > 3 && <span className="tnum" title={i.labels.slice(3).join(", ")}>+{i.labels.length - 3}</span>}
                    </div>
                  </li>
                ))}
                {c.items.length === 0 && <li className="p-2 text-[12.5px] text-ink-3">Empty</li>}
              </ul>
            </Panel>
          ))}
        </div>
      )}
      {board?.data?.truncated && <p className="text-[12.5px] text-ink-3">Showing the first <span className="tnum">{shown}</span> cards. Open the other instance to see the rest.</p>}
      {tasks?.data && (
        <Panel title={<>Tasks <span className="tnum font-normal text-ink-3">{tasks.data.tasks.length}{tasks.data.nextCursor ? "+" : ""}</span></>} collapsible={false}>
          {tasks.data.tasks.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">No tasks you can see.</p>
          ) : (
            <ul>
              {tasks.data.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line p-3 last:border-b-0">
                  <span className="wrap-any min-w-0 font-medium">{t.title}</span>
                  <span className="flex flex-wrap gap-x-3 text-[12px] text-ink-3">
                    <span>{t.columnName}</span>
                    {t.priority > 0 && <span className="tnum">P{t.priority}</span>}
                    {t.dueDate && <span className="tnum">Due {formatDateOnly(new Date(`${t.dueDate}T00:00:00Z`))}</span>}
                    {t.assignee && <span className="break-all"><bdi>@{t.assignee}</bdi></span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {tasks.data.nextCursor && <p className="border-t border-line p-3 text-[12.5px] text-ink-3">Showing the first <span className="tnum">{tasks.data.tasks.length}</span> tasks. Open the other instance to see the rest.</p>}
        </Panel>
      )}
    </>
  );
}

/**
 * A project of a linked instance, read-only: board or list. Every query is scoped to the signed-in person and this link; the answer
 * is whatever the other instance chose to show to the account you linked. No card here can be moved, edited or opened elsewhere.
 */
export default async function LinkedProject({ params, searchParams }: { params: Promise<{ linkId: string; projectId: string }>; searchParams: Promise<{ view?: string }> }) {
  const { linkId, projectId } = await params;
  if (!ID.test(linkId) || !ID.test(projectId)) notFound();
  const { viewer } = await requireViewer();
  const ctx = liveCtx();
  if (!ctx) notFound();
  const list = (await searchParams).view === "list";
  const link = await db.federationLink.findFirst({ where: { id: linkId, workspaceId: viewer.workspaceId, userId: viewer.userId, status: "ACTIVE" }, select: { peerOrigin: true } });
  if (!link) notFound();
  const peer = link.peerOrigin.replace(/^https?:\/\//, "");
  const base = `/linked/${encodeURIComponent(linkId)}/projects/${encodeURIComponent(projectId)}`;
  return (
    <>
      <PageHeader
        title="Linked project"
        subtitle={`from ${peer} (read-only)`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="View" items={[{ href: base, label: "Board", active: !list }, { href: `${base}?view=list`, label: "List", active: list }]} />
            <Link href="/linked" className="btn">All linked</Link>
          </div>
        }
      />
      <AutoRefresh seconds={90} />
      <div className="flex flex-col gap-4">
        <Suspense fallback={<BoardSkeleton />}>
          <ProjectBody ctx={ctx} viewer={viewer} linkId={linkId} projectId={projectId} peer={peer} list={list} />
        </Suspense>
      </div>
    </>
  );
}
