import Link from "next/link";
import { readScope } from "@/lib/scope";
import { ScopeNote } from "@/components/shell/ScopeNote";
import { ViewBar } from "@/components/views/ViewBar";
import { listViews } from "@/lib/services/views";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listProjects } from "@/lib/services/queries";
import { assigneeCandidates, listTasks, priorityName, taskCounts, type TaskScope } from "@/lib/services/tasks";
import { isOverdue, todayIn } from "@/lib/domain/planning";
import { formatDateOnly, relativeTime } from "@/lib/format";
import { Avatar, EmptyState, LabelChip, PageHeader, Panel, Segmented } from "@/components/ui/primitives";
import { CalendarDays, Flag, ListChecks, MessageSquare } from "@/components/ui/icons";
import { ctx } from "@/lib/ctx";
import { NewTask } from "@/components/tasks/NewTask";

export const metadata = { title: "Tasks" };

type Search = { scope?: string; project?: string; status?: string; label?: string; q?: string };
const SCOPES: { key: TaskScope; label: string }[] = [
  { key: "mine", label: "Assigned to me" },
  { key: "by-me", label: "Assigned by me" },
  { key: "unassigned", label: "Unassigned" },
  { key: "all", label: "All" },
];

export default async function Tasks({ searchParams }: { searchParams: Promise<Search> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const scope = (SCOPES.find((s) => s.key === sp.scope)?.key ?? "mine") as TaskScope;
  const status = sp.status === "done" || sp.status === "all" ? sp.status : "open";
  const projects = await listProjects(db, viewer);
  const workScope = await readScope(db, viewer);
  const project = projects.find((p) => p.id === (sp.project || (workScope.kind === "project" ? workScope.id : "")));
  const [tasks, counts] = await Promise.all([listTasks(db, viewer, { scope, projectId: project?.id, status, label: sp.label || undefined, q: sp.q }), taskCounts(db, viewer)]);
  const peopleByProject: Record<string, string[]> = {};
  for (const p of projects) peopleByProject[p.id] = await assigneeCandidates(db, viewer, p.id);
  const today = todayIn(viewer.timezone);
  const now = new Date();
  const href = (over: Partial<Search>) => {
    const u = new URLSearchParams();
    const merged: Search = { scope, project: project?.id, status: status === "open" ? undefined : status, label: sp.label, q: sp.q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    const qs = u.toString();
    return qs ? `/tasks?${qs}` : "/tasks";
  };
  const countFor = (k: TaskScope) => (k === "mine" ? counts.mine : k === "by-me" ? counts.byMe : k === "unassigned" ? counts.unassigned : counts.all);

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="Create a task, give it to someone, and talk about it. Tasks are the same cards as on the planning board and sync to everyone in the project's team."
        actions={projects.length > 0 ? <NewTask projects={projects.map((p) => ({ id: p.id, name: p.name }))} peopleByProject={peopleByProject} me={viewer.login} defaultProjectId={project?.id ?? projects[0].id} /> : undefined}
      />
      <ScopeNote scope={workScope} />
      <ViewBar scope="tasks" views={await listViews(db, viewer, "tasks")} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented label="Whose tasks" items={SCOPES.map((s) => ({ href: href({ scope: s.key }), label: `${s.label} (${countFor(s.key)})`, active: s.key === scope }))} />
        <Segmented label="Status" items={(["open", "done", "all"] as const).map((s) => ({ href: href({ status: s === "open" ? undefined : s }), label: s[0].toUpperCase() + s.slice(1), active: s === status }))} />
        {projects.length > 1 && <Segmented label="Project" items={[{ href: href({ project: undefined }), label: "All projects", active: !project }, ...projects.map((p) => ({ href: href({ project: p.id }), label: p.name, active: p.id === project?.id }))]} />}
        <form method="get" action="/tasks" className="ml-auto flex items-center gap-2">
          {scope !== "mine" && <input type="hidden" name="scope" value={scope} />}
          {project && <input type="hidden" name="project" value={project.id} />}
          {status !== "open" && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={sp.q ?? ""} className="input !w-56" placeholder="Search tasks" aria-label="Search tasks" />
        </form>
      </div>
      {sp.label && <p className="mb-2 text-[12.5px] text-ink-3">Label: <LabelChip name={sp.label} color="888888" /> <Link className="link" href={href({ label: undefined })}>clear</Link></p>}
      <Panel bodyClassName="p-0">
        {tasks.length === 0 ? (
          <EmptyState icon={ListChecks} title={scope === "mine" ? "Nothing is assigned to you" : "No tasks here"}>
            {projects.length === 0 ? "You are not part of a project yet. Ask an administrator to add you to one." : "Create a task, or change the filters above."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((t) => {
              const overdue = isOverdue(t.dueDate, t.column.key, today);
              return (
                <li key={t.id} data-ctx={ctx([{ label: "Copy task title", copy: t.title }])}>
                  <Link href={`/tasks/${t.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-hover">
                    <span className="mt-0.5 shrink-0 text-ink-3" aria-hidden><ListChecks size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-ink">{t.title}</span>
                        {(t.labels as string[]).map((l) => <LabelChip key={l} name={l} color="7c8aa5" />)}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
                        <span>{t.project.name}</span>
                        <span>{t.column.name}</span>
                        {t.workItem && <span>{t.workItem.repository.fullName}#{t.workItem.number}</span>}
                        {t.priority > 0 && <span className={`inline-flex items-center gap-1 prio-${t.priority}`}><Flag size={12} aria-hidden />{priorityName(t.priority)}</span>}
                        {t.dueDate && <span className={overdue ? "inline-flex items-center gap-1 text-blocked" : "inline-flex items-center gap-1"}><CalendarDays size={12} aria-hidden />{overdue ? "Overdue " : "Due "}{formatDateOnly(t.dueDate)}</span>}
                        {t.checklist.total > 0 && <span className={`inline-flex items-center gap-1 ${t.checklist.done === t.checklist.total ? "text-ok" : ""}`}><ListChecks size={12} aria-hidden /><span className="sr-only">Checklist </span>{t.checklist.done}/{t.checklist.total}</span>}
                        {t._count.comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquare size={12} aria-hidden />{t._count.comments}</span>}
                        <span>updated {relativeTime(t.updatedAt, now)}</span>
                      </span>
                    </span>
                    {t.assigneeLogin ? (
                      <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-2"><Avatar login={t.assigneeLogin} size={22} /><span className="hidden sm:inline">{t.assigneeLogin}</span></span>
                    ) : (
                      <span className="shrink-0 text-[12.5px] text-ink-3">Unassigned</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
