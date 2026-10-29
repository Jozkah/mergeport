"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { openLocal } from "@/lib/local/open-local";
import { addMapping, deleteMapping } from "@/lib/services/label-taxonomy";
import { addDraft, deleteDraft, discardDrafts, submitDrafts } from "@/lib/services/review-extras";
import { checkBackportLocally, createAdoption, createSubscription, deleteBackport, deleteSubscription, recordBackport, setSubscriptionMuted } from "@/lib/services/upstream-extras";
import { knownWorktreePath, setTaskBranch } from "@/lib/services/work-links";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

// ---------- draft reviews ----------

export async function addDraftAction(input: { id: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await addDraft(db, viewer, input.id, input);
    return { ok: true, message: "Added to your pending review. Nothing has been sent yet." };
  });
}

export async function deleteDraftAction(draftId: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteDraft(db, viewer, draftId);
    return { ok: true };
  });
}

export async function discardDraftsAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await discardDrafts(db, viewer, id);
    return { ok: true };
  });
}

export async function submitDraftsAction(input: { id: string; event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; body: string }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const r = await submitDrafts({ db, v: viewer }, input.id, { event: input.event, body: input.body });
    revalidatePath(`/pull-requests/${input.id}`);
    return { ok: true, message: `Review submitted to GitHub with ${r.comments} comment${r.comments === 1 ? "" : "s"}` };
  });
}

// ---------- labels ----------

export async function addMappingAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await addMapping(db, viewer, { concept: str(fd, "concept"), spelling: str(fd, "spelling"), repositoryId: str(fd, "repositoryId") || null });
    revalidatePath("/admin/labels");
    return { ok: true, message: "Mapping saved. Labels on GitHub are not changed." };
  });
}

export async function deleteMappingAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await deleteMapping(db, viewer, str(fd, "id"));
    revalidatePath("/admin/labels");
    return { ok: true };
  });
}

// ---------- upstream ----------

export async function subscriptionAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const op = str(fd, "op");
    if (op === "delete") await deleteSubscription(db, viewer, str(fd, "id"));
    else if (op === "mute" || op === "unmute") await setSubscriptionMuted(db, viewer, str(fd, "id"), op === "mute");
    else await createSubscription(db, viewer, { name: str(fd, "name"), mappingId: str(fd, "mappingId") || null, criteria: { labels: csv(str(fd, "labels")), paths: csv(str(fd, "paths")), authors: csv(str(fd, "authors")), titleContains: csv(str(fd, "words")), milestone: str(fd, "milestone") } });
    revalidatePath("/forks");
    return { ok: true, message: "Saved" };
  });
}

export async function backportAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const op = str(fd, "op");
    const base = { mappingId: str(fd, "mappingId"), upstreamNumber: Number(str(fd, "number")), targetBranch: str(fd, "branch") };
    if (op === "delete") {
      await deleteBackport(db, viewer, str(fd, "id"));
      revalidatePath("/forks");
      return { ok: true };
    }
    if (op === "check") {
      const r = await checkBackportLocally(db, viewer, base);
      revalidatePath("/forks");
      return { ok: true, message: r.reason, data: { result: r.result } };
    }
    await recordBackport(db, viewer, { ...base, state: op === "done" ? "done" : "planned", note: str(fd, "note") });
    revalidatePath("/forks");
    return { ok: true, message: op === "done" ? "Marked as addressed (your decision, recorded as manual)" : "Planned" };
  });
}

export async function adoptionAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const items = csv(str(fd, "items")).map((x) => ({ kind: x.startsWith("i") ? ("issue" as const) : ("pr" as const), number: Number(x.replace(/^[pi]/, "")) }));
    const r = await createAdoption(db, viewer, { mappingId: str(fd, "mappingId"), items, targetBranch: str(fd, "branch"), projectId: str(fd, "projectId"), name: str(fd, "name") || undefined, assigneeLogin: str(fd, "assignee") || null });
    revalidatePath("/planning");
    revalidatePath("/tasks");
    revalidatePath("/forks");
    return { ok: true, message: `Plan created with ${r.taskIds.length} task${r.taskIds.length === 1 ? "" : "s"} and a final sync step`, data: { milestoneId: r.milestoneId } };
  });
}

// ---------- worktrees ----------

export async function taskBranchAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await setTaskBranch(db, viewer, str(fd, "taskId"), str(fd, "branch") || null);
    revalidatePath(`/tasks/${str(fd, "taskId")}`);
    return { ok: true, message: "Saved" };
  });
}

export async function openWorktreeAction(input: { repositoryId: string; path: string; how: "folder" | "editor" }): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const path = await knownWorktreePath(db, viewer, input.repositoryId, input.path);
    const r = await openLocal(path, input.how === "editor" ? "editor" : "folder");
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}
