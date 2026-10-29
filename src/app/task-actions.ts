"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { addCheckItems, deleteCheckItem, editCheckItem, moveCheckItem, setCheckItemDone } from "@/lib/services/checklist";
import { addComment, createTask, deleteComment, deleteTask, editComment, updateTask } from "@/lib/services/tasks";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const day = (s: string) => (s ? new Date(s + "T00:00:00Z") : null);

function refresh(id?: string) {
  revalidatePath("/tasks");
  revalidatePath("/planning");
  revalidatePath("/attention");
  if (id) revalidatePath(`/tasks/${id}`);
}

export async function createTaskAction(fd: FormData): Promise<ActionResult> {
  let id = "";
  const r = await run(async () => {
    const { viewer } = await requireViewer();
    const t = await createTask(db, viewer, {
      projectId: str(fd, "projectId"),
      title: str(fd, "title"),
      description: str(fd, "description"),
      assigneeLogin: str(fd, "assignee") || null,
      priority: Number(str(fd, "priority") || 0),
      dueDate: day(str(fd, "due")),
      labels: str(fd, "labels"),
    });
    id = t.id;
    refresh();
    return { ok: true, message: "Task created", data: { id: t.id } };
  });
  if (r.ok && fd.get("goto") === "1") redirect(`/tasks/${id}`);
  return r;
}

export async function updateTaskAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const id = str(fd, "id");
    const has = (k: string) => fd.has(k);
    await updateTask(db, viewer, id, {
      title: has("title") ? str(fd, "title") : undefined,
      description: has("description") ? String(fd.get("description") ?? "") : undefined,
      assigneeLogin: has("assignee") ? str(fd, "assignee") || null : undefined,
      priority: has("priority") ? Number(str(fd, "priority") || 0) : undefined,
      dueDate: has("due") ? day(str(fd, "due")) : undefined,
      labels: has("labels") ? str(fd, "labels") : undefined,
      columnKey: has("status") ? str(fd, "status") : undefined,
      tickOpenItems: fd.get("tickOpen") === "on",
    });
    refresh(id);
    return { ok: true, message: "Saved" };
  });
}

export async function addCommentAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const id = str(fd, "id");
    await addComment(db, viewer, id, String(fd.get("body") ?? ""));
    refresh(id);
    return { ok: true, message: "Comment added" };
  });
}

export async function editCommentAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const c = await editComment(db, viewer, str(fd, "commentId"), String(fd.get("body") ?? ""));
    refresh(c.itemId);
    return { ok: true, message: "Comment updated" };
  });
}

export async function deleteCommentAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteComment(db, viewer, str(fd, "commentId"));
    refresh(str(fd, "id"));
    return { ok: true, message: "Comment deleted" };
  });
}

export async function deleteTaskAction(fd: FormData): Promise<ActionResult> {
  let done = false;
  const r = await run(async () => {
    const { viewer } = await requireViewer();
    await deleteTask(db, viewer, str(fd, "id"));
    refresh();
    done = true;
    return { ok: true, message: "Task deleted" };
  });
  if (done) redirect("/tasks");
  return r;
}

// ---------- checklist ----------

export async function addCheckItemsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const id = str(fd, "id");
    const made = await addCheckItems(db, viewer, id, String(fd.get("text") ?? ""));
    refresh(id);
    return { ok: true, message: made.length === 1 ? "Item added" : `${made.length} items added` };
  });
}

export async function setCheckItemAction(input: { id: string; done: boolean }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const c = await setCheckItemDone(db, viewer, input.id, !!input.done);
    refresh(c.itemId);
    return { ok: true };
  });
}

export async function editCheckItemAction(input: { id: string; text: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const c = await editCheckItem(db, viewer, input.id, input.text);
    refresh(c.itemId);
    return { ok: true };
  });
}

export async function deleteCheckItemAction(input: { id: string; taskId: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteCheckItem(db, viewer, input.id);
    refresh(input.taskId);
    return { ok: true };
  });
}

export async function moveCheckItemAction(input: { id: string; afterId: string | null; taskId: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await moveCheckItem(db, viewer, input.id, input.afterId);
    refresh(input.taskId);
    return { ok: true };
  });
}
