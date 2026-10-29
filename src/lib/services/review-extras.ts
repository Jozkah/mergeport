import type { Db } from "@/lib/db";
import { requireRepo, requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { CODEOWNERS_PATHS, parseCodeowners, routeFiles, type Routing } from "@/lib/domain/codeowners";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { GithubError, type GithubPort } from "@/lib/github/port";
import { portForWrite } from "@/lib/github/factory";
import { audit } from "./audit";
import { derivedDetail } from "./queries";
import { portFor, pullFilesView } from "./git-view";
import { syncItem } from "@/lib/sync/repository";

// ---------- CODEOWNERS-aware routing ----------

export type OwnerStatus = "approved" | "changes-requested" | "pending" | "not-requested" | "unknown";
export type OwnerRow = { owner: string; kind: "user" | "team" | "email"; files: string[]; patterns: string[]; status: OwnerStatus; note: string };
export type OwnersView = {
  file: { path: string; branch: string } | null;
  routing: Routing | null;
  rows: OwnerRow[];
  /** Where each reviewer requirement the dashboard knows about comes from, so the CODEOWNERS list is read next to it. */
  otherSources: { who: string; why: string }[];
  /** CODEOWNERS only routes attention. Whether GitHub requires an owner review depends on branch protection, which is not read here. */
  requirement: "unknown";
  notes: string[];
};

/**
 * Reads CODEOWNERS from the pull request's BASE branch (that is the file GitHub itself uses) and routes the changed files to owners.
 * It is advice from the repository's own file, shown beside the review requests and rules Mergeport already knows, never merged into them.
 */
export async function pullOwnersView(db: Db, v: Viewer, id: string, port?: GithubPort): Promise<OwnersView> {
  const item = await requireWorkItem(db, v, id);
  if (item.type !== "PULL_REQUEST") throw new NotFoundError();
  const full = await db.workItem.findUniqueOrThrow({ where: { id }, include: { repository: { include: { owner: true } } } });
  const p = port ?? (await portFor(db, full.repositoryId));
  const branch = full.baseRef ?? full.repository.defaultBranch ?? "main";
  let found: { path: string; text: string } | null = null;
  for (const path of CODEOWNERS_PATHS) {
    try {
      const c = await p.getContents(full.repository.owner.login, full.repository.name, path, branch);
      if (c.kind === "file" && c.file.text !== null) {
        found = { path, text: c.file.text };
        break;
      }
    } catch (e) {
      if (!(e instanceof GithubError && e.kind === "not-found")) throw e;
    }
  }
  const derived = await derivedDetail(db, v, id);
  const otherSources = derived.derivation.actors.map((a) => ({ who: a.actor.ref, why: a.evidence }));
  if (!found) return { file: null, routing: null, rows: [], otherSources, requirement: "unknown", notes: [`There is no CODEOWNERS file on ${branch}, so no owners are suggested.`] };

  const files = await pullFilesView(db, v, id, false);
  const routing = routeFiles(files.files.map((f) => f.filename), parseCodeowners(found.text));
  const status = (login: string): OwnerStatus => {
    const a = derived.derivation.actors.find((x) => x.actor.kind === "USER" && x.actor.ref.toLowerCase() === login.toLowerCase());
    if (!a) return "not-requested";
    return a.status === "APPROVED" ? "approved" : a.status === "CHANGES_REQUESTED" ? "changes-requested" : "pending";
  };
  const rows: OwnerRow[] = routing.entries.map((e) => {
    if (e.owner.kind === "user") {
      const s = status(e.owner.ref);
      return { owner: e.owner.raw, kind: "user", files: e.files, patterns: e.patterns, status: s, note: s === "not-requested" ? "Owns these files but has not been asked to review" : s === "approved" ? "Approved on the current commit" : s === "changes-requested" ? "Asked for changes" : "Review requested" };
    }
    if (e.owner.kind === "team") return { owner: e.owner.raw, kind: "team", files: e.files, patterns: e.patterns, status: "unknown", note: "Team membership is not readable with this account, so whether a member reviewed is not known" };
    return { owner: e.owner.raw, kind: "email", files: e.files, patterns: e.patterns, status: "unknown", note: "An email owner cannot be matched to a GitHub account here" };
  });
  const notes = [`From ${found.path} on ${branch}. The last matching line wins for each file.`];
  if (routing.invalid.length) notes.push(`Not understood, so skipped: ${routing.invalid.join(", ")}`);
  if (files.truncated) notes.push("The file list is truncated, so some owners may be missing.");
  return { file: { path: found.path, branch }, routing, rows, otherSources, requirement: "unknown", notes };
}

// ---------- draft review batches ----------

export type DraftRow = { id: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string; commitSha: string; stale: boolean };

async function reviewTarget(db: Db, v: Viewer, id: string) {
  const item = await requireWorkItem(db, v, id, "review");
  if (item.type !== "PULL_REQUEST") throw new ValidationError("Only pull requests have reviews");
  return item;
}

export async function addDraft(db: Db, v: Viewer, id: string, input: { path: string; line: number; side?: string; body: string }) {
  const item = await reviewTarget(db, v, id);
  if (!item.headSha) throw new ValidationError("This pull request has no head commit yet");
  const body = input.body.trim();
  if (!body) throw new ValidationError("Write the comment first");
  if (body.length > 65_000) throw new ValidationError("That comment is too long");
  if (!Number.isInteger(input.line) || input.line < 1) throw new ValidationError("Choose a line");
  if (!input.path.trim() || input.path.length > 500) throw new ValidationError("Choose a file");
  if ((await db.reviewDraft.count({ where: { userId: v.userId, workItemId: id } })) >= 200) throw new ValidationError("A pending review can hold at most 200 comments");
  return db.reviewDraft.create({ data: { userId: v.userId, workItemId: id, path: input.path, line: input.line, side: input.side === "LEFT" ? "LEFT" : "RIGHT", body, commitSha: item.headSha } });
}

export async function listDrafts(db: Db, v: Viewer, id: string): Promise<DraftRow[]> {
  const item = await requireWorkItem(db, v, id);
  const rows = await db.reviewDraft.findMany({ where: { userId: v.userId, workItemId: id }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, path: r.path, line: r.line, side: r.side === "LEFT" ? "LEFT" : "RIGHT", body: r.body, commitSha: r.commitSha, stale: !!item.headSha && r.commitSha !== item.headSha }));
}

export async function deleteDraft(db: Db, v: Viewer, draftId: string) {
  const r = await db.reviewDraft.findFirst({ where: { id: draftId, userId: v.userId } });
  if (!r) throw new NotFoundError();
  await db.reviewDraft.delete({ where: { id: draftId } });
}

export async function discardDrafts(db: Db, v: Viewer, id: string) {
  await requireWorkItem(db, v, id);
  await db.reviewDraft.deleteMany({ where: { userId: v.userId, workItemId: id } });
}

/**
 * Sends the pending review as ONE review with all its comments, as the acting person. If the pull request moved since a comment was
 * drafted, nothing is sent: line numbers may no longer mean the same thing, and the person decides what to keep. On failure the drafts stay.
 */
export async function submitDrafts(ctx: { db: Db; v: Viewer; port?: GithubPort }, id: string, input: { event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; body: string }) {
  const { db, v } = ctx;
  const item = await reviewTarget(db, v, id);
  const drafts = await db.reviewDraft.findMany({ where: { userId: v.userId, workItemId: id }, orderBy: { createdAt: "asc" } });
  if (input.event === "APPROVE" && item.authorLogin?.toLowerCase() === v.login.toLowerCase()) throw new ValidationError("You cannot approve your own pull request");
  if (input.event !== "APPROVE" && drafts.length === 0 && !input.body.trim()) throw new ValidationError("Add a comment to explain the review");
  const stale = drafts.filter((d) => d.commitSha !== item.headSha);
  if (stale.length) throw new ForbiddenError(`${stale.length} of your comments were written on an older version. The pull request has changed: review them, delete the ones that no longer apply, and submit again`);
  const repo = await requireRepo(db, v, item.repositoryId, "review");
  const owner = await db.githubOwner.findUniqueOrThrow({ where: { id: repo.ownerId } });
  const user = await db.user.findUniqueOrThrow({ where: { id: v.userId } });
  const port = ctx.port ?? (await portForWrite(db, user, repo));
  await port.submitReview(owner.login, repo.name, item.number, { event: input.event, body: input.body.trim() || undefined, commitSha: item.headSha ?? undefined, comments: drafts.map((d) => ({ path: d.path, line: d.line, side: d.side === "LEFT" ? "LEFT" : "RIGHT", body: d.body })) });
  await db.reviewDraft.deleteMany({ where: { id: { in: drafts.map((d) => d.id) } } });
  await syncItem(db, port, repo.id, item.number).catch(() => false);
  await audit(db, v, "github.review-batch", { type: "WorkItem", id }, { event: input.event, comments: drafts.length });
  return { comments: drafts.length };
}

// ---------- threads ----------

export type ThreadRow = { key: string; firstCommentId: string; path: string; line: number | null; resolved: boolean | null; comments: number; author: string | null; preview: string };

/**
 * Review threads with GitHub's resolved flag. Resolved is true, false, or null (never read): null is shown as "not known",
 * never counted as unresolved. Resolving happens on GitHub, which this links to, because it is not available through the REST API.
 */
export async function reviewThreads(db: Db, v: Viewer, id: string): Promise<{ threads: ThreadRow[]; unresolved: number; unknown: number; githubUrl: string }> {
  const item = await requireWorkItem(db, v, id);
  const rows = await db.workItemComment.findMany({ where: { workItemId: id, kind: "REVIEW_COMMENT", threadKey: { not: null } }, orderBy: { createdAtGh: "asc" } });
  const by = new Map<string, typeof rows>();
  for (const r of rows) (by.get(r.threadKey!) ?? by.set(r.threadKey!, []).get(r.threadKey!)!).push(r);
  const threads: ThreadRow[] = [...by].map(([key, list]) => ({ key, firstCommentId: list[0].id, path: list[0].path ?? "", line: list[0].line, resolved: list.find((c) => c.threadResolved !== null)?.threadResolved ?? null, comments: list.length, author: list[0].authorLogin, preview: (list[0].body ?? "").slice(0, 120) }));
  return { threads, unresolved: threads.filter((t) => t.resolved === false).length, unknown: threads.filter((t) => t.resolved === null).length, githubUrl: `${item.htmlUrl}/files` };
}
