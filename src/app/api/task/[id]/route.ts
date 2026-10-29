import { db } from "@/lib/db";
import { withViewer } from "@/lib/api-viewer";
import { getTask, priorityName } from "@/lib/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The task behind a card, for the side drawer. Same authorization as the full page (getTask), and only plain serializable fields. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer(async (v) => {
    const { task, full, comments, checklist, dependencies } = await getTask(db, v, id);
    return {
      id: task.id,
      title: full.workItem?.title ?? task.title,
      description: task.description,
      column: task.column.name,
      assignee: task.assigneeLogin,
      priority: priorityName(task.priority),
      due: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
      labels: Array.isArray(task.labels) ? task.labels : [],
      milestone: full.milestone?.name ?? null,
      github: full.workItem ? { repo: full.workItem.repository.fullName, number: full.workItem.number, href: full.workItem.type === "PULL_REQUEST" ? `/pull-requests/${full.workItem.id}` : `/issues/${full.workItem.id}` } : null,
      dependencies: dependencies.map((d) => (d.opaque ? { opaque: true, direction: d.direction, kind: d.kind } : { opaque: false, direction: d.direction, kind: d.kind, id: d.id, title: d.title, done: d.done })),
      checklist: checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
      comments: comments.map((c) => ({ id: c.id, author: c.authorLogin, kind: c.kind, body: c.body, at: c.createdAt.toISOString() })),
    };
  });
}
