import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { NotFoundError } from "@/lib/errors";
import { assigneeCandidates, getTask, priorityName } from "@/lib/services/tasks";
import { isOverdue, todayIn } from "@/lib/domain/planning";
import { formatDateOnly, formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Avatar, LabelChip, PageHeader, Panel, Time } from "@/components/ui/primitives";
import { ArrowLeft, CalendarDays, ExternalLink, Flag, ListChecks, MessageSquare, Pencil, Trash2 } from "@/components/ui/icons";
import { Checklist } from "@/components/tasks/Checklist";
import { TaskFields } from "@/components/tasks/TaskFields";
import { addCommentAction, deleteCommentAction, deleteTaskAction, editCommentAction, updateTaskAction } from "@/app/task-actions";

export const metadata = { title: "Task" };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { viewer } = await requireViewer();
  const { id } = await params;
  let data: Awaited<ReturnType<typeof getTask>>;
  try {
    data = await getTask(db, viewer, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const { task, full, comments, columns, checklist } = data;
  const openItems = checklist.filter((c) => !c.done).length;
  const people = await assigneeCandidates(db, viewer, task.projectId);
  const today = todayIn(viewer.timezone);
  const overdue = isOverdue(task.dueDate, task.column.key, today);
  const linked = full.workItem;
  const labels = task.labels as string[];
  const canDelete = !task.workItemId && (viewer.isAdmin || task.authorLogin?.toLowerCase() === viewer.login.toLowerCase() || task.createdById === viewer.memberId);
  const dueValue = task.dueDate ? task.dueDate.toISOString().slice(0, 10) : "";

  return (
    <>
      <p className="mb-2"><Link href="/tasks" className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink"><ArrowLeft size={13} aria-hidden /> Tasks</Link></p>
      <PageHeader
        title={task.title}
        subtitle={<>in {task.project.name} · {task.authorLogin ? <>created by @{task.authorLogin} · </> : null}{task.column.name}</>}
        actions={
          task.assigneeLogin?.toLowerCase() === viewer.login.toLowerCase() ? undefined : (
            <ActionForm action={updateTaskAction} submitLabel="Assign to me" pendingLabel="Assigning…" submitClassName="btn" resetOnSuccess={false}>
              <input type="hidden" name="id" value={task.id} /><input type="hidden" name="assignee" value={viewer.login} />
            </ActionForm>
          )
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Description" icon={Pencil} actions={null}>
            <div className="p-4 text-[13.5px]">
              {task.description ? <p className="whitespace-pre-wrap break-words text-ink-2">{task.description}</p> : <p className="text-ink-3">No description yet.</p>}
              {linked && (
                <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                  Follows <Link href={`/${linked.type === "PULL_REQUEST" ? "pull-requests" : "issues"}/${linked.id}`} className="link">{linked.repository.fullName}#{linked.number}</Link>
                  <a href={`${linked.repository.htmlUrl}/${linked.type === "PULL_REQUEST" ? "pull" : "issues"}/${linked.number}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 link">GitHub <ExternalLink size={12} aria-hidden /></a>
                </p>
              )}
              {!linked && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[12.5px] text-ink-2">Edit title and description</summary>
                  <ActionForm action={updateTaskAction} submitLabel="Save" pendingLabel="Saving…" resetOnSuccess={false} className="mt-3">
                    <input type="hidden" name="id" value={task.id} />
                    <div className="flex flex-col gap-3">
                      <div><label className="label" htmlFor="e-title">Title</label><input id="e-title" name="title" className="input" defaultValue={task.title} required maxLength={200} /></div>
                      <div><label className="label" htmlFor="e-desc">Description</label><textarea id="e-desc" name="description" className="input min-h-28" rows={5} defaultValue={task.description ?? ""} /></div>
                    </div>
                  </ActionForm>
                </details>
              )}
            </div>
          </Panel>

          <Panel title={`Checklist${checklist.length ? ` (${checklist.filter((c) => c.done).length}/${checklist.length})` : ""}`} icon={ListChecks}>
            <Checklist taskId={task.id} items={checklist.map((c) => ({ id: c.id, text: c.text, done: c.done, doneByLogin: c.doneByLogin }))} />
          </Panel>

          <Panel title={`Discussion${comments.some((c) => c.kind === "COMMENT") ? ` (${comments.filter((c) => c.kind === "COMMENT").length})` : ""}`} icon={MessageSquare}>
            <ol className="flex flex-col">
              {comments.map((c) =>
                c.kind === "EVENT" ? (
                  <li key={c.id} className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12.5px] text-ink-3 last:border-b-0">
                    <Avatar login={c.authorLogin} size={16} />
                    <span><strong className="font-medium text-ink-2">@{c.authorLogin}</strong> {c.body} · <Time value={c.createdAt} formatted={formatInstant(c.createdAt, viewer.timezone)} /></span>
                  </li>
                ) : (
                  <li key={c.id} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
                    <Avatar login={c.authorLogin} size={28} />
                    <div className="min-w-0 flex-1 text-[13.5px]">
                      <p className="text-[12.5px] text-ink-3"><strong className="font-medium text-ink">@{c.authorLogin}</strong> · <Time value={c.createdAt} formatted={formatInstant(c.createdAt, viewer.timezone)} />{c.editedAt ? " · edited" : ""}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{c.body}</p>
                      {(c.authorLogin.toLowerCase() === viewer.login.toLowerCase() || viewer.isAdmin) && (
                        <div className="mt-2 flex flex-wrap items-start gap-3 text-[12px]">
                          {c.authorLogin.toLowerCase() === viewer.login.toLowerCase() && (
                            <details>
                              <summary className="cursor-pointer text-ink-3 hover:text-ink">Edit</summary>
                              <ActionForm action={editCommentAction} submitLabel="Save" pendingLabel="Saving…" resetOnSuccess={false} className="mt-2">
                                <input type="hidden" name="commentId" value={c.id} />
                                <textarea name="body" className="input min-h-20" rows={3} defaultValue={c.body} required aria-label="Edit comment" />
                              </ActionForm>
                            </details>
                          )}
                          <ActionForm action={deleteCommentAction} submitLabel="Delete" pendingLabel="Deleting…" submitClassName="text-ink-3 hover:text-blocked" resetOnSuccess={false}>
                            <input type="hidden" name="commentId" value={c.id} /><input type="hidden" name="id" value={task.id} />
                          </ActionForm>
                        </div>
                      )}
                    </div>
                  </li>
                ),
              )}
            </ol>
            <div className="border-t border-line p-4">
              <ActionForm action={addCommentAction} submitLabel="Comment" pendingLabel="Posting…">
                <input type="hidden" name="id" value={task.id} />
                <label className="label" htmlFor="c-body">Add a comment</label>
                <textarea id="c-body" name="body" className="input min-h-24" rows={3} required maxLength={8000} placeholder="Write a comment. Everyone who can see this task can read it." />
              </ActionForm>
            </div>
          </Panel>
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <Panel title="Details">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                <dt className="text-ink-3">Assignee</dt>
                <dd className="flex items-center gap-2">{task.assigneeLogin ? <><Avatar login={task.assigneeLogin} size={20} />{task.assigneeLogin}{task.assignedByLogin && task.assignedByLogin !== task.assigneeLogin ? <span className="text-ink-3">by @{task.assignedByLogin}</span> : null}</> : <span className="text-ink-3">Nobody</span>}</dd>
                <dt className="text-ink-3">Priority</dt>
                <dd className="inline-flex items-center gap-1"><Flag size={13} aria-hidden />{priorityName(task.priority)}</dd>
                <dt className="text-ink-3">Due</dt>
                <dd className={overdue ? "inline-flex items-center gap-1 text-blocked" : "inline-flex items-center gap-1"}><CalendarDays size={13} aria-hidden />{task.dueDate ? `${formatDateOnly(task.dueDate)}${overdue ? " (overdue)" : ""}` : "None"}</dd>
                <dt className="text-ink-3">Labels</dt>
                <dd className="flex flex-wrap gap-1">{labels.length ? labels.map((l) => <Link key={l} href={`/tasks?scope=all&status=all&label=${encodeURIComponent(l)}`}><LabelChip name={l} color="7c8aa5" /></Link>) : <span className="text-ink-3">None</span>}</dd>
                {full.milestone && (<><dt className="text-ink-3">Milestone</dt><dd>{full.milestone.name}</dd></>)}
              </dl>
              {(full.blockedBy.length > 0 || full.blocks.length > 0) && (
                <div className="border-t border-line pt-3 text-[12.5px]">
                  {full.blockedBy.length > 0 && <p className="text-ink-3">Blocked by {full.blockedBy.map((l) => <Link key={l.fromId} href={`/tasks/${l.from.id}`} className="link mr-2">{l.from.title}</Link>)}</p>}
                  {full.blocks.length > 0 && <p className="mt-1 text-ink-3">Blocks {full.blocks.map((l) => <Link key={l.toId} href={`/tasks/${l.to.id}`} className="link mr-2">{l.to.title}</Link>)}</p>}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Change">
            <ActionForm action={updateTaskAction} submitLabel="Save changes" pendingLabel="Saving…" resetOnSuccess={false} className="p-4">
              <input type="hidden" name="id" value={task.id} />
              <div className="flex flex-col gap-3">
                <div><label className="label" htmlFor="s-status">Status</label>
                  <Select id="s-status" name="status" className="select" defaultValue={task.column.key}>{columns.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</Select></div>
                {openItems > 0 && <label className="flex items-start gap-2 text-[12.5px] text-ink-2"><input type="checkbox" name="tickOpen" className="mt-0.5" /> <span>If I move this to Done, also check the {openItems} open checklist item{openItems === 1 ? "" : "s"}.</span></label>}
                <TaskFields people={people} me={viewer.login} values={{ assignee: task.assigneeLogin ?? "", priority: task.priority, due: dueValue, labels: labels.join(", ") }} />
              </div>
            </ActionForm>
          </Panel>

          {canDelete && (
            <details className="rounded-[10px] border border-line p-3 text-[13px]">
              <summary className="cursor-pointer text-ink-2"><Trash2 size={13} className="mr-1 inline" aria-hidden />Delete this task</summary>
              <ActionForm action={deleteTaskAction} submitLabel="Delete task" pendingLabel="Deleting…" submitClassName="btn" className="mt-3" resetOnSuccess={false}>
                <input type="hidden" name="id" value={task.id} />
                <p className="mb-2 text-ink-3">The task, its discussion and its history are removed for everyone in the team. This cannot be undone.</p>
              </ActionForm>
            </details>
          )}
        </aside>
      </div>
    </>
  );
}
