"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { addDependency, removeDependency } from "@/lib/services/planning";
import { applySuggestion, assignEpic, assignIteration, closeIteration, createBoard, createEpic, createIteration, deleteBoard, deleteEpic, setAutomation, setShipped, updateBoard, updateEpic } from "@/lib/services/planning-ext";
import { createTaskFromTemplate, promoteTask } from "@/lib/services/task-promotion";
import type { GroupBy } from "@/lib/domain/boards";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const day = (s: string) => (s ? new Date(`${s}T00:00:00Z`) : null);
const refresh = () => {
  revalidatePath("/planning");
  revalidatePath("/tasks");
  revalidatePath("/attention");
};

export async function createBoardAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const b = await createBoard(db, viewer, { projectId: str(fd, "projectId"), template: str(fd, "template") || undefined, name: str(fd, "name") || undefined });
    refresh();
    return { ok: true, message: `Board “${b.name}” created`, data: { id: b.id } };
  });
}

/** Columns arrive as lines "key" or "key | label | limit" so a person can reorder, rename and limit them in one box. */
export async function updateBoardAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const lines = str(fd, "columns").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const columns = lines.map((l) => {
      const [key, name, wip] = l.split("|").map((x) => x.trim());
      return { key, name: name || undefined, wip: wip ? Number(wip) : null };
    });
    await updateBoard(db, viewer, str(fd, "id"), { name: str(fd, "name"), columns, groupBy: str(fd, "groupBy") as GroupBy, density: str(fd, "density") });
    refresh();
    return { ok: true, message: "Board saved" };
  });
}

export async function deleteBoardAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteBoard(db, viewer, str(fd, "id"));
    refresh();
    return { ok: true, message: "Board removed. Its cards are untouched." };
  });
}

export async function createEpicAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await createEpic(db, viewer, { projectId: str(fd, "projectId"), title: str(fd, "title"), description: str(fd, "description"), ownerLogin: str(fd, "owner") || null, startDate: day(str(fd, "start")), targetDate: day(str(fd, "target")), decisions: str(fd, "decisions") });
    refresh();
    return { ok: true, message: "Epic created" };
  });
}

export async function epicStatusAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (str(fd, "delete") === "1") await deleteEpic(db, viewer, str(fd, "id"));
    else await updateEpic(db, viewer, str(fd, "id"), { status: str(fd, "status") === "DONE" ? "DONE" : "OPEN" });
    refresh();
    return { ok: true };
  });
}

export async function assignEpicAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await assignEpic(db, viewer, str(fd, "itemId"), str(fd, "epicId") || null);
    refresh();
    return { ok: true, message: "Saved" };
  });
}

export async function createIterationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const start = day(str(fd, "start"));
    const end = day(str(fd, "end"));
    if (!start || !end) throw new Error("Choose a start and an end date");
    await createIteration(db, viewer, { projectId: str(fd, "projectId"), name: str(fd, "name"), startDate: start, endDate: end });
    refresh();
    return { ok: true, message: "Iteration created" };
  });
}

export async function assignIterationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await assignIteration(db, viewer, str(fd, "itemId"), str(fd, "iterationId") || null);
    refresh();
    return { ok: true, message: "Saved" };
  });
}

export async function closeIterationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const r = await closeIteration(db, viewer, str(fd, "id"), str(fd, "carryTo") || null);
    refresh();
    return { ok: true, message: r.carried ? `Closed. ${r.carried} unfinished card${r.carried === 1 ? "" : "s"} carried over.` : "Closed" };
  });
}

export async function shipAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setShipped(db, viewer, str(fd, "id"), str(fd, "shipped") !== "0", { tag: str(fd, "tag"), url: str(fd, "url") });
    refresh();
    return { ok: true, message: str(fd, "shipped") === "0" ? "Marked as not shipped" : "Marked as shipped" };
  });
}

export async function automationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setAutomation(db, viewer, str(fd, "projectId"), str(fd, "mode") === "suggest" ? "suggest" : "off");
    refresh();
    return { ok: true, message: "Saved" };
  });
}

export async function applySuggestionAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await applySuggestion(db, viewer, str(fd, "itemId"));
    refresh();
    return { ok: true, message: "Moved on the board. Nothing was changed on GitHub." };
  });
}

export async function linkAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (str(fd, "remove") === "1") await removeDependency(db, viewer, str(fd, "fromId"), str(fd, "toId"));
    else await addDependency(db, viewer, str(fd, "fromId"), str(fd, "toId"), str(fd, "kind") || "blocks");
    refresh();
    return { ok: true, message: "Saved" };
  });
}

export async function templateTaskAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const t = await createTaskFromTemplate(db, viewer, { projectId: str(fd, "projectId"), template: str(fd, "template"), title: str(fd, "title"), assigneeLogin: str(fd, "assignee") || null });
    refresh();
    return { ok: true, message: "Task created from the template", data: { id: t.id } };
  });
}

export async function promoteAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const r = await promoteTask(db, viewer, str(fd, "taskId"), str(fd, "repositoryId"));
    revalidatePath(`/tasks/${str(fd, "taskId")}`);
    refresh();
    return { ok: true, message: `Issue #${r.number} created on GitHub and linked to this task` };
  });
}
