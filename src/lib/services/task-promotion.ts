import type { Db } from "@/lib/db";
import type { GithubPort } from "@/lib/github/port";
import { repoWhere, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { templateByKey } from "@/lib/domain/task-templates";
import { ValidationError } from "@/lib/errors";
import { audit } from "./audit";
import { addCheckItems } from "./checklist";
import { createIssue } from "./work-actions";
import { githubWrite, validateWriteText, withFooter, writeRefusal, type RefusalReason } from "@/lib/github/writes";
import { syncItem } from "@/lib/sync/repository";
import { sha256 } from "@/lib/crypto";
import { createTask, loadTask, loadTaskForWrite } from "./tasks";

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

export type PromotionPreview = { destination: { id: string; fullName: string }; title: string; body: string; labels: string[]; keeps: string[]; note: string; /** What the confirmation sheet showed, as a hash: the confirm sends it back and promoteTask refuses if the task changed since. */ fingerprint: string; /** Why this person cannot create it right now (turned off, GitHub not linked, ...), or null. */ refusal: RefusalReason | null };

const body = (t: { description: string | null; checklist: { text: string; done: boolean }[] }) => {
  const nl = String.fromCharCode(10);
  const parts: string[] = [];
  if (t.description?.trim()) parts.push(t.description.trim());
  if (t.checklist.length) parts.push(t.checklist.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join(nl));
  return withFooter(parts.join(nl + nl));
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

/** For the New task dialog: per project, the repositories this person may create an issue in (same rule as promotionDestinations). */
export async function issueDestinationsByProject(db: Db, v: Viewer, projectIds: string[]): Promise<Record<string, { id: string; fullName: string }[]>> {
  const out: Record<string, { id: string; fullName: string }[]> = {};
  if (!projectIds.length) return out;
  const repos = await db.repository.findMany({
    where: { AND: [repoWhere(v), { projects: { some: { projectId: { in: projectIds } } } }, { trackingStatus: "ACTIVE" }, ...(v.isAdmin ? [] : [{ grants: { some: { memberId: v.memberId, revokedAt: null, canManageWork: true } } }])] },
    select: { id: true, fullName: true, githubId: true, installationId: true, isDemo: true, workspaceId: true, projects: { where: { projectId: { in: projectIds } }, select: { projectId: true } } },
    orderBy: { fullName: "asc" },
  });
  for (const r of repos) {
    if ((await writeRefusal(db, v, r)) !== null) continue; // only where every gate would pass: turned off, GitHub not linked, no access, ... offer nothing
    for (const p of r.projects) (out[p.projectId] ??= []).push({ id: r.id, fullName: r.fullName });
  }
  return out;
}

/** A task that already follows a GitHub item, or whose issue was created and is waiting to be matched by the next sync. */
const isLinked = (t: { workItemId: string | null; workNumber: number | null }) => t.workItemId !== null || t.workNumber !== null;

/** What would be sent, shown before anything is written. Nothing is created by previewing. */
export async function previewPromotion(db: Db, v: Viewer, taskId: string, repositoryId: string): Promise<PromotionPreview> {
  const t = await loadTask(db, v, taskId);
  if (isLinked(t)) throw new ValidationError("This task already follows a GitHub item");
  const dest = (await promotionDestinations(db, v, taskId)).find((r) => r.id === repositoryId);
  if (!dest) throw new ValidationError("Choose one of this project's repositories that you can manage");
  const repo = await db.repository.findFirstOrThrow({ where: { id: repositoryId, workspaceId: v.workspaceId } });
  const checklist = await db.taskCheckItem.findMany({ where: { itemId: taskId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  // Labels are never sent to a real repository: this change writes an issue and nothing else on GitHub.
  const labels = repo.isDemo && Array.isArray(t.labels) ? (t.labels as string[]) : [];
  const refusal = await writeRefusal(db, v, repo);
  const text = body({ description: t.description, checklist });
  const nl = String.fromCharCode(10);
  const fingerprint = sha256([t.title, text, checklist.map((c) => `${c.done ? 1 : 0}${c.text}`).join(nl)].join(nl));
  return { destination: dest, title: t.title, body: text, labels, refusal, fingerprint, keeps: ["The same task: its comments, checklist, assignee, board position and history", "A link to the new issue, so it is never created twice"], note: "Creates one issue on GitHub as you. The task stays on the board and follows the issue afterwards." };
}

/**
 * Creates the issue as the acting person and links the SAME planning record to it, so nothing is duplicated and the task keeps its
 * identity. A task that already follows an item cannot be promoted twice, and a double submit creates one issue (a one-shot lock per
 * task, released only if GitHub refused). A real repository goes through the write gate (src/lib/github/writes.ts).
 */
export async function promoteTask(db: Db, v: Viewer, taskId: string, repositoryId: string, port?: GithubPort, previewed?: string) {
  await loadTaskForWrite(db, v, taskId); // links the shared card to the new issue, so a read-only project must refuse before anything is created on GitHub
  const preview = await previewPromotion(db, v, taskId, repositoryId);
  const repo = await requireRepo(db, v, repositoryId, "manageWork");
  validateWriteText({ title: preview.title, body: preview.body }, { titleRequired: true });
  // A real write posts exactly what the confirmation sheet showed: the title, text and checklist are re-read here and must still hash the same.
  if (!repo.isDemo && !port && previewed !== preview.fingerprint) throw new ValidationError("The task changed. Review it again.");
  let number: number;
  if (repo.isDemo || port) {
    number = (await createIssue({ db, v, port }, repositoryId, { title: preview.title, body: preview.body, labels: preview.labels })).number;
  } else {
    number = (
      await githubWrite({ db, v }, {
        kind: "issue.create",
        repo,
        target: { type: "PlanningItem", id: taskId },
        dedupeKey: `ghwrite:issue:${taskId}`,
        call: async (p) => {
          const created = await p.createIssue(repo.owner.login, repo.name, { title: preview.title, body: preview.body });
          // The issue exists now: link the task at once, so nothing after this point can leave it unlinked (and tempt a second issue). Best effort here; the update below repeats it.
          await db.planningItem.update({ where: { id: taskId }, data: { workRepoGithubId: repo.githubId, workNumber: created.number, version: { increment: 1 } } }).catch(() => undefined);
          await syncItem(db, p, repo.id, created.number).catch(() => false); // best effort, as the person who just made it; sync.item follows from the queue
          return created;
        },
        numberOf: (r) => r.number,
      })
    ).number;
  }
  const wi = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number } } });
  await db.planningItem.update({ where: { id: taskId }, data: { workItemId: wi?.id ?? null, workRepoGithubId: repo.githubId, workNumber: number } });
  await db.taskComment.create({ data: { itemId: taskId, authorLogin: v.login, kind: "EVENT", body: `promoted this to ${repo.fullName}#${number}` } });
  await audit(db, v, "task.promote", { type: "PlanningItem", id: taskId }, { repository: repo.fullName, number });
  return { number, workItemId: wi?.id ?? null };
}

/** The mirror just learned about issue #number: tasks that were linked to it by number (created before the mirror had it) now point at the work item. */
export async function linkPendingTasks(db: Db, repositoryId: string, number: number): Promise<void> {
  const wi = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number } }, include: { repository: { select: { githubId: true, workspaceId: true } } } });
  if (!wi) return;
  await db.planningItem.updateMany({ where: { workItemId: null, workRepoGithubId: wi.repository.githubId, workNumber: number, project: { workspaceId: wi.repository.workspaceId } }, data: { workItemId: wi.id } });
}
