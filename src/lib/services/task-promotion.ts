import type { Db } from "@/lib/db";
import type { GithubPort } from "@/lib/github/port";
import { repoWhere, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { templateByKey } from "@/lib/domain/task-templates";
import { ValidationError } from "@/lib/errors";
import { audit } from "./audit";
import { addCheckItems } from "./checklist";
import { createIssue } from "./work-actions";
import { createTask, loadTask } from "./tasks";

/** Starting a task from a built-in template, and turning a local task into a GitHub issue without losing its identity. */

export async function createTaskFromTemplate(db: Db, v: Viewer, input: { projectId: string; template: string; title: string; assigneeLogin?: string | null }) {
  const t = templateByKey(input.template);
  if (!t) throw new ValidationError("Unknown template");
  const rest = input.title.trim();
  if (!rest) throw new ValidationError("Give the task a title");
  const task = await createTask(db, v, { projectId: input.projectId, title: `${t.titlePrefix}${rest}`, description: t.description, labels: t.labels, priority: t.priority, assigneeLogin: input.assigneeLogin });
  await addCheckItems(db, v, task.id, t.checklist.join(String.fromCharCode(10)));
  return task;
}

export type PromotionPreview = { destination: { id: string; fullName: string }; title: string; body: string; labels: string[]; keeps: string[]; note: string };

const body = (t: { description: string | null; checklist: { text: string; done: boolean }[] }) => {
  const nl = String.fromCharCode(10);
  const parts: string[] = [];
  if (t.description?.trim()) parts.push(t.description.trim());
  if (t.checklist.length) parts.push(t.checklist.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join(nl));
  parts.push("_Created from a Mergeport task._");
  return parts.join(nl + nl);
};

/** Where a task may be promoted to: repositories of its project that this person can manage. */
export async function promotionDestinations(db: Db, v: Viewer, taskId: string) {
  const t = await loadTask(db, v, taskId);
  const repos = await db.repository.findMany({
    where: { AND: [repoWhere(v), { projects: { some: { projectId: t.projectId } } }, { trackingStatus: "ACTIVE" }, ...(v.isAdmin ? [] : [{ grants: { some: { memberId: v.memberId, revokedAt: null, canManageWork: true } } }])] },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  return repos;
}

/** What would be sent, shown before anything is written. Nothing is created by previewing. */
export async function previewPromotion(db: Db, v: Viewer, taskId: string, repositoryId: string): Promise<PromotionPreview> {
  const t = await loadTask(db, v, taskId);
  if (t.workItemId) throw new ValidationError("This task already follows a GitHub item");
  const dest = (await promotionDestinations(db, v, taskId)).find((r) => r.id === repositoryId);
  if (!dest) throw new ValidationError("Choose one of this project's repositories that you can manage");
  const checklist = await db.taskCheckItem.findMany({ where: { itemId: taskId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  const labels = Array.isArray(t.labels) ? (t.labels as string[]) : [];
  return { destination: dest, title: t.title, body: body({ description: t.description, checklist }), labels, keeps: ["The same task: its comments, checklist, assignee, board position and history", "A link to the new issue, so it is never created twice"], note: "Creates one issue on GitHub as you. The task stays on the board and follows the issue afterwards." };
}

/**
 * Creates the issue as the acting person and links the SAME planning record to it, so nothing is duplicated and the task keeps its
 * identity. A task that already follows an item cannot be promoted twice.
 */
export async function promoteTask(db: Db, v: Viewer, taskId: string, repositoryId: string, port?: GithubPort) {
  const preview = await previewPromotion(db, v, taskId, repositoryId);
  const repo = await requireRepo(db, v, repositoryId, "manageWork");
  const created = await createIssue({ db, v, port }, repositoryId, { title: preview.title, body: preview.body, labels: preview.labels });
  const wi = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number: created.number } } });
  if (!wi) throw new ValidationError(`Issue #${created.number} was created on GitHub, but could not be linked yet. Refresh the repository and link it from the board`);
  await db.planningItem.update({ where: { id: taskId }, data: { workItemId: wi.id, workRepoGithubId: repo.githubId, workNumber: created.number, version: { increment: 1 } } });
  await db.taskComment.create({ data: { itemId: taskId, authorLogin: v.login, kind: "EVENT", body: `promoted this to ${repo.fullName}#${created.number}` } });
  await audit(db, v, "task.promote", { type: "PlanningItem", id: taskId }, { repository: repo.fullName, number: created.number });
  return { number: created.number, workItemId: wi.id };
}
