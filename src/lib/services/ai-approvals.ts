import type { Db } from "@/lib/db";
import { viaRepo, type Viewer } from "@/lib/authz/viewer";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseQuestion } from "./ai-facts";
import { listWorkItems } from "./queries";
import * as work from "./work-actions";

/**
 * AI apps (through the MCP server) cannot change anything on GitHub. They can only ASK: a request is stored here, shown to the
 * person with its exact text, and performed only when the person approves it in Mergeport, as themselves, through the same code
 * as the buttons on the pull request page (same permission checks, same audit entry). Requests older than a day are ignored.
 */

export type ActionKind = "comment" | "request-review" | "review";
export const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
const EXPIRES_MS = 24 * 3_600_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type Pending = { id: string; kind: ActionKind; summary: string; detail: string; href: string; createdAt: Date; error: string | null };

/** The one pull request or issue a request is about: an id, or text like "PR 22 from paymentgateway". Ambiguity is an error, never a guess. */
export async function resolveItem(db: Db, v: Viewer, query: string) {
  const q = query.trim();
  if (!q) throw new ValidationError("Say which pull request or issue.");
  if (/^c[a-z0-9]{20,}$/.test(q)) {
    const row = await db.workItem.findFirst({ where: { id: q, ...viaRepo(v) }, include: { repository: true } });
    if (!row) throw new NotFoundError();
    return row;
  }
  const { numbers, hints, type } = parseQuestion(q);
  if (numbers.length !== 1) throw new ValidationError("Name exactly one pull request or issue, with its number, for example \"PR 22 from owner/repo\".");
  const rows = (await listWorkItems(db, v, { type, state: "ALL", q: String(numbers[0]), pageSize: 25 })).rows.filter((r) => r.number === numbers[0]);
  const narrowed = hints.length ? rows.filter((r) => hints.some((h) => r.repository.fullName.toLowerCase().includes(h))) : rows;
  const pick = narrowed.length ? narrowed : rows;
  if (pick.length === 0) throw new ValidationError(`No stored pull request or issue matches "${q}".`);
  if (pick.length > 1) throw new ValidationError(`"${q}" matches several: ${pick.slice(0, 6).map((r) => `${r.repository.fullName}#${r.number}`).join(", ")}. Add the repository name.`);
  return pick[0];
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Stores a request. Validation that does not need GitHub happens now, so an obviously wrong request is refused to the AI at once. */
export async function propose(db: Db, v: Viewer, input: { kind: ActionKind; item: string; body?: string; users?: string[]; event?: string }) {
  const item = await resolveItem(db, v, input.item);
  const label = `${item.repository.fullName}#${item.number}`;
  let summary: string;
  let payload: Record<string, unknown>;
  if (input.kind === "comment") {
    const body = (input.body ?? "").trim();
    if (!body) throw new ValidationError("The comment is empty.");
    if (body.length > 65_000) throw new ValidationError("That comment is too long.");
    summary = `Comment on ${label}`;
    payload = { body };
  } else if (input.kind === "request-review") {
    if (item.type !== "PULL_REQUEST") throw new ValidationError("Only pull requests can have review requests.");
    const users = [...new Set((input.users ?? []).map((u) => u.trim().replace(/^@/, "")).filter(Boolean))];
    if (users.length === 0 || users.length > 10 || users.some((u) => !LOGIN.test(u))) throw new ValidationError("Give between one and ten GitHub usernames.");
    summary = `Request a review on ${label} from ${users.map((u) => `@${u}`).join(", ")}`;
    payload = { users };
  } else {
    if (item.type !== "PULL_REQUEST") throw new ValidationError("Only pull requests can be reviewed.");
    const event = (REVIEW_EVENTS as readonly string[]).includes(input.event ?? "") ? (input.event as (typeof REVIEW_EVENTS)[number]) : null;
    if (!event) throw new ValidationError("The review must be COMMENT, REQUEST_CHANGES or APPROVE.");
    const body = (input.body ?? "").trim();
    if (event !== "APPROVE" && !body) throw new ValidationError("Add the text of the review.");
    summary = `${event === "APPROVE" ? "Approve" : event === "REQUEST_CHANGES" ? "Request changes on" : "Review (comment) on"} ${label}`;
    payload = { event, body };
  }
  const row = await db.aiPendingAction.create({ data: { kind: input.kind, workItemId: item.id, summary, payload: payload as never } });
  return { id: row.id, summary, label };
}

const detailOf = (kind: string, p: Record<string, unknown>) => (kind === "request-review" ? `Reviewers: ${(p.users as string[]).map((u) => `@${u}`).join(", ")}` : String(p.body ?? "") || "(no text)");

export async function listPending(db: Db, now = new Date()): Promise<Pending[]> {
  const rows = await db.aiPendingAction.findMany({ where: { state: "PENDING", createdAt: { gte: new Date(now.getTime() - EXPIRES_MS) } }, orderBy: { createdAt: "desc" }, take: 30 });
  const items = await db.workItem.findMany({ where: { id: { in: rows.map((r) => r.workItemId) } }, select: { id: true, type: true } });
  const type = new Map(items.map((i) => [i.id, i.type]));
  return rows.map((r) => ({ id: r.id, kind: r.kind as ActionKind, summary: r.summary, detail: detailOf(r.kind, r.payload as Record<string, unknown>), href: `/${type.get(r.workItemId) === "ISSUE" ? "issues" : "pull-requests"}/${r.workItemId}`, createdAt: r.createdAt, error: r.result && r.result.startsWith("Not sent") ? r.result : null }));
}

export async function pendingCount(db: Db, now = new Date()): Promise<number> {
  return db.aiPendingAction.count({ where: { state: "PENDING", createdAt: { gte: new Date(now.getTime() - EXPIRES_MS) } } });
}

/** Performs one approved request as the signed-in person. It is claimed first, so a double click cannot send it twice. */
export async function approve(db: Db, v: Viewer, id: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const claimed = await db.aiPendingAction.updateMany({ where: { id, state: "PENDING", createdAt: { gte: new Date(now.getTime() - EXPIRES_MS) } }, data: { state: "DONE", decidedAt: now } });
  if (claimed.count === 0) throw new ValidationError("That request is no longer waiting (already decided, or older than a day).");
  const row = await db.aiPendingAction.findUniqueOrThrow({ where: { id } });
  const p = row.payload as Record<string, unknown>;
  const ctx = { db, v };
  try {
    if (row.kind === "comment") await work.addComment(ctx, row.workItemId, String(p.body));
    else if (row.kind === "request-review") await work.requestReview(ctx, row.workItemId, p.users as string[]);
    else await work.submitReview(ctx, row.workItemId, p.event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE", String(p.body ?? ""));
    await db.aiPendingAction.update({ where: { id }, data: { result: "Sent to GitHub" } });
    return { ok: true, message: `Sent: ${row.summary}` };
  } catch (e) {
    const message = e instanceof ForbiddenError || e instanceof ValidationError || e instanceof NotFoundError ? e.message : e instanceof Error ? cut(e.message, 300) : "It failed.";
    // A request that could not be sent goes back to waiting with the reason, so it can be tried again or rejected, never silently lost.
    await db.aiPendingAction.update({ where: { id }, data: { state: "PENDING", decidedAt: null, result: `Not sent: ${message}` } });
    return { ok: false, message: `Not sent: ${message}` };
  }
}

export async function reject(db: Db, id: string, now = new Date()): Promise<boolean> {
  const r = await db.aiPendingAction.updateMany({ where: { id, state: "PENDING" }, data: { state: "REJECTED", decidedAt: now, result: "Rejected by the person" } });
  return r.count > 0;
}

/** For the AI app that asked: where its request stands. */
export async function status(db: Db, id: string, now = new Date()): Promise<{ state: string; summary: string; result: string | null }> {
  const r = await db.aiPendingAction.findUnique({ where: { id } });
  if (!r) throw new NotFoundError();
  const expired = r.state === "PENDING" && now.getTime() - r.createdAt.getTime() > EXPIRES_MS;
  return { state: expired ? "EXPIRED" : r.state, summary: r.summary, result: r.result };
}
