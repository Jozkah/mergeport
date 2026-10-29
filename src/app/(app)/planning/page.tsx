import { Select } from "@/components/ui/Select";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listProjects } from "@/lib/services/queries";
import { milestoneProgress } from "@/lib/services/planning";
import { attachableWorkItems, planningBoard, roadmap } from "@/lib/services/planning-view";
import { formatDateOnly } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { EmptyState, Mono, PageHeader, Panel, Segmented, LabelChip } from "@/components/ui/primitives";
import { CalendarDays, Kanban, Milestone, Plus, ListChecks } from "@/components/ui/icons";
import { Board } from "@/components/planning/Board";
import { addDependencyAction, createCardAction, createMilestoneAction } from "@/app/actions";

export const metadata = { title: "Planning" };

type Search = { project?: string; view?: string };

export default async function Planning({ searchParams }: { searchParams: Promise<Search> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const projects = await listProjects(db, viewer);
  const view = sp.view === "list" || sp.view === "roadmap" ? sp.view : "board";
  const project = projects.find((p) => p.id === sp.project) ?? projects[0];
  const href = (over: Search) => {
    const u = new URLSearchParams({ view, ...(project ? { project: project.id } : {}), ...over } as Record<string, string>);
    return `/planning?${u.toString()}`;
  };

  if (!project) {
    return (
      <>
        <PageHeader title="Planning" />
        <Panel title="Planning" icon={Kanban}><EmptyState icon={Kanban} title="No project to plan in">You are not part of a project that contains a repository you can see. Ask an administrator to add you to a project and grant repository access.</EmptyState></Panel>
      </>
    );
  }

  const [{ columns, cards }, attachable, ms] = await Promise.all([planningBoard(db, viewer, project.id), attachableWorkItems(db, viewer, project.id), roadmap(db, viewer)]);
  const milestoneOptions = ms.filter((m) => !m.projectId || m.projectId === project.id);
  const colName = new Map(columns.map((c) => [c.key, c.name]));
  const projectsSeg = <Segmented label="Project" items={projects.map((p) => ({ href: href({ project: p.id }), label: p.name, active: p.id === project.id }))} />;
  const viewSeg = <Segmented label="View" items={(["board", "list", "roadmap"] as const).map((v) => ({ href: href({ view: v }), label: v[0].toUpperCase() + v.slice(1), active: v === view }))} />;

  const progresses = view === "roadmap" ? await Promise.all(ms.map(async (m) => ({ id: m.id, p: (await milestoneProgress(db, viewer, m.id)).progress }))) : [];
  const dated = ms.filter((m) => m.startDate || m.targetDate);
  const nowMs = new Date().getTime();
  const lo = Math.min(...dated.map((m) => (m.startDate ?? m.targetDate!).getTime()), nowMs);
  const hi = Math.max(...dated.map((m) => (m.targetDate ?? m.startDate!).getTime()), nowMs + 7 * 86400_000);
  const pct = (t: number) => ((t - lo) / Math.max(1, hi - lo)) * 100;

  return (
    <>
      <PageHeader
        title="Planning"
        subtitle={`${project.name}: ${cards.length} card${cards.length === 1 ? "" : "s"} you can see. Dragging a card changes only the board, never the GitHub issue or its labels.`}
        actions={
          <>
            <Sheet title="Add a card" description="Link an open GitHub item, or write an internal task for project members." trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> Add card</button>}>
              <ActionForm action={createCardAction} submitLabel="Add card" pendingLabel="Adding…">
                <input type="hidden" name="projectId" value={project.id} />
                <div className="flex flex-col gap-3">
                  <div><label className="label" htmlFor="c-work">Link a GitHub issue or pull request</label>
                    <Select id="c-work" name="workItemId" className="select"><option value="">None: internal task</option>{attachable.map((w) => <option key={w.id} value={w.id}>{w.repository.fullName}#{w.number} {w.title.slice(0, 60)}</option>)}</Select></div>
                  <div><label className="label" htmlFor="c-title">Task title (internal tasks)</label><input id="c-title" name="title" className="input" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label" htmlFor="c-col">Column</label><Select id="c-col" name="column" className="select">{columns.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</Select></div>
                    <div><label className="label" htmlFor="c-pri">Priority</label><Select id="c-pri" name="priority" className="select"><option value="0">None</option><option value="1">P1</option><option value="2">P2</option><option value="3">P3</option></Select></div>
                    <div><label className="label" htmlFor="c-due">Due date</label><input id="c-due" name="due" type="date" className="input" /></div>
                    <div><label className="label" htmlFor="c-ms">Milestone</label><Select id="c-ms" name="milestoneId" className="select"><option value="">None</option>{milestoneOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></div>
                  </div>
                </div>
              </ActionForm>
            </Sheet>
            {viewer.isAdmin && (
              <Sheet title="New dashboard milestone" description="Spans repositories and lives in the dashboard. Repository milestones on GitHub stay separate." trigger={<button className="btn"><Milestone size={14} aria-hidden /> New milestone</button>}>
                <ActionForm action={createMilestoneAction} submitLabel="Create milestone">
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="flex flex-col gap-3">
                    <div><label className="label" htmlFor="m-name">Name</label><input id="m-name" name="name" className="input" required /></div>
                    <div><label className="label" htmlFor="m-desc">Description</label><input id="m-desc" name="description" className="input" /></div>
                    <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="m-start">Start date</label><input id="m-start" name="start" type="date" className="input" /></div><div><label className="label" htmlFor="m-target">Target date</label><input id="m-target" name="target" type="date" className="input" /></div></div>
                  </div>
                </ActionForm>
              </Sheet>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">{projects.length > 1 && projectsSeg}{viewSeg}</div>

      {view === "board" && (
        <Panel title="Board" icon={Kanban} id="board" bodyClassName="p-3">
          {cards.length === 0 && <EmptyState icon={Kanban} title="No cards yet">Add a card to start planning this project.</EmptyState>}
          <Board columns={columns.map((c) => ({ id: c.id, key: c.key, name: c.name }))} initial={cards} />
        </Panel>
      )}

      {view === "list" && (
        <Panel title="List" icon={ListChecks} id="list">
          {cards.length === 0 ? <EmptyState icon={ListChecks} title="No cards yet" /> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Cards (scrolls horizontally on narrow screens)">
              <table className="data min-w-[760px]">
                <thead><tr><th scope="col">Card</th><th scope="col">Column</th><th scope="col">Assignee</th><th scope="col">Priority</th><th scope="col">Milestone</th><th scope="col">Due</th></tr></thead>
                <tbody>
                  {cards.map((c) => (
                    <tr key={c.id}>
                      <td><div className="font-medium [overflow-wrap:anywhere]">{c.href ? <Link href={c.href} className="hover:underline">{c.title}</Link> : c.title}</div><div className="mt-0.5 text-[12px] text-ink-3">{c.isDraft ? "Internal task" : <Mono>{c.repoFullName}#{c.number}</Mono>}{c.waitingOn ? ` · waiting on ${c.waitingOn}` : ""}{c.blockedBy ? ` · blocked by ${c.blockedBy}` : ""}</div>{c.labels.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.labels.map((l) => <LabelChip key={l.name} {...l} />)}</div>}</td>
                      <td>{colName.get(c.columnKey)}</td><td>{c.assignee ? `@${c.assignee}` : "—"}</td><td className="tnum">{c.priority ? `P${c.priority}` : "—"}</td><td>{c.milestoneName ?? "—"}</td>
                      <td className={`tnum ${c.overdue ? "text-blocked" : ""}`}>{c.dueLabel ?? "—"}{c.overdue ? " (overdue)" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {view === "roadmap" && (
        <Panel title="Roadmap" icon={CalendarDays} id="roadmap">
          {ms.length === 0 ? <EmptyState icon={Milestone} title="No dashboard milestones">An administrator can create milestones that span repositories.</EmptyState> : (
            <ul className="flex flex-col">
              {ms.map((m) => {
                const p = progresses.find((x) => x.id === m.id)!.p;
                const s = m.startDate ?? m.targetDate;
                return (
                  <li key={m.id} className="border-b border-line p-4 last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{m.name}</p><p className="tnum text-[12.5px] text-ink-3">{m.startDate ? formatDateOnly(m.startDate) : "No start"} → {m.targetDate ? formatDateOnly(m.targetDate) : "No target"}</p></div>
                    {m.description && <p className="text-[12.5px] text-ink-3">{m.description}</p>}
                    {s ? (
                      <div className="relative mt-3 h-6 rounded-[6px] bg-muted" aria-hidden>
                        <div className="absolute inset-y-0 rounded-[6px] bg-ink/85" style={{ left: `${pct(s.getTime())}%`, width: `${Math.max(1.5, pct((m.targetDate ?? s).getTime()) - pct(s.getTime()))}%` }} />
                        <div className="absolute inset-y-0 w-px bg-blocked" style={{ left: `${pct(nowMs)}%` }} title="Today" />
                      </div>
                    ) : <p className="mt-2 text-[12.5px] text-ink-3">Unscheduled</p>}
                    <p className="tnum mt-2 text-[12.5px]">{p.percent === null ? "No visible work yet" : `${p.done} of ${p.total} done (${p.percent}%)`} <span className="text-ink-3">· {p.label}</span></p>
                    <p className="text-[11.5px] text-ink-3">{p.explanation}</p>
                    {m.repoLinks.length > 0 && <p className="mt-1 text-[11.5px] text-ink-3">Linked repository milestones (repository-scoped on GitHub): {m.repoLinks.map((l) => `${l.repository.fullName} #${l.githubMilestoneNumber}`).join(", ")}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}

      {cards.length > 1 && view !== "roadmap" && (
        <div className="mt-5">
          <Panel title="Dependencies" icon={ListChecks} id="deps">
            <div className="p-4">
              <ActionForm action={addDependencyAction} submitLabel="Add dependency" submitClassName="btn" className="grid max-w-[640px] gap-3 sm:grid-cols-2">
                <div><label className="label" htmlFor="dep-a">This card blocks</label><Select id="dep-a" name="blockerId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 60)}</option>)}</Select></div>
                <div><label className="label" htmlFor="dep-b">This card</label><Select id="dep-b" name="blockedId" className="select" required>{cards.map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 60)}</option>)}</Select></div>
              </ActionForm>
              <p className="mt-2 text-[12px] text-ink-3">Cycles are rejected. A blocker you cannot see still counts as blocking and appears as “not visible to you”.</p>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
