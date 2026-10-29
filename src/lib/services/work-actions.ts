import type { Db } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireRepo, requireWorkItem, type Viewer } from "@/lib/authz/viewer";
import { portForWrite } from "@/lib/github/factory";
import type { GithubPort, MergeMethod } from "@/lib/github/port";
import { syncItem } from "@/lib/sync/repository";
import { derivedDetail } from "./queries";
import { audit } from "./audit";

/**
 * Writes to GitHub. Every path: (1) the item must be visible, (2) the viewer's GRANT must include the
 * capability, (3) the call is made with the ACTING USER's credential (never an admin's or the installation's),
 * (4) the item is re-fetched from the source of truth, (5) the action is audited.
 */

type Ctx = { db: Db; v: Viewer; port?: GithubPort };

async function load(ctx: Ctx, workItemId: string, cap: "manageWork" | "review") {
  const item = await requireWorkItem(ctx.db, ctx.v, workItemId, cap);
  const repo = await requireRepo(ctx.db, ctx.v, item.repositoryId, cap);
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.v.userId } });
  const port = ctx.port ?? (await portForWrite(ctx.db, user, repo));
  return { item, repo, port, owner: repo.owner.login, name: repo.name };
}

async function refresh(ctx: Ctx, port: GithubPort, repositoryId: string, number: number) {
  await syncItem(ctx.db, port, repositoryId, number).catch(() => false);
}

export async function addComment(ctx: Ctx, workItemId: string, body: string) {
  if (!body.trim()) throw new ValidationError("Write a comment first");
  if (body.length > 65_000) throw new ValidationError("That comment is too long");
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "manageWork");
  await port.createComment(owner, name, item.number, body);
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.comment", { type: "WorkItem", id: item.id });
}

export async function setLabels(ctx: Ctx, workItemId: string, labels: string[]) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "manageWork");
  const clean = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].slice(0, 50);
  await port.setLabels(owner, name, item.number, clean);
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.labels", { type: "WorkItem", id: item.id }, { labels: clean });
}

export async function setAssignees(ctx: Ctx, workItemId: string, assignees: string[]) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "manageWork");
  const clean = [...new Set(assignees.map((a) => a.trim().replace(/^@/, "")).filter(Boolean))].slice(0, 10);
  await port.setAssignees(owner, name, item.number, clean);
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.assignees", { type: "WorkItem", id: item.id }, { assignees: clean });
}

/** Repository milestones are repo-scoped; the number must be one that repository uses. */
export async function setRepoMilestone(ctx: Ctx, workItemId: string, milestoneNumber: number | null) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "manageWork");
  await port.setMilestone(owner, name, item.number, milestoneNumber);
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.milestone", { type: "WorkItem", id: item.id }, { milestoneNumber });
}

export async function requestReview(ctx: Ctx, workItemId: string, users: string[], teams: string[] = []) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "review");
  if (item.type !== "PULL_REQUEST") throw new ValidationError("Only pull requests have GitHub review requests. Use a manual waiting record for issues.");
  if (item.state !== "OPEN") throw new ValidationError("This pull request is not open");
  const u = users.map((x) => x.trim().replace(/^@/, "")).filter(Boolean);
  if (u.length + teams.length === 0) throw new ValidationError("Name at least one reviewer");
  await port.requestReviewers(owner, name, item.number, { users: u, teams });
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.request-review", { type: "WorkItem", id: item.id }, { users: u, teams });
}

export async function submitReview(ctx: Ctx, workItemId: string, event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES", body: string) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "review");
  if (item.type !== "PULL_REQUEST" || item.state !== "OPEN") throw new ValidationError("Only open pull requests can be reviewed");
  if (item.authorLogin?.toLowerCase() === ctx.v.login.toLowerCase() && event === "APPROVE") throw new ValidationError("You cannot approve your own pull request");
  if (event !== "APPROVE" && !body.trim()) throw new ValidationError("Add a comment to explain the review");
  await port.submitReview(owner, name, item.number, { event, body: body.trim() || undefined, commitSha: item.headSha ?? undefined });
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.review", { type: "WorkItem", id: item.id }, { event });
}

export async function createIssue(ctx: Ctx, repositoryId: string, input: { title: string; body?: string; labels?: string[] }) {
  const repo = await requireRepo(ctx.db, ctx.v, repositoryId, "manageWork");
  if (!input.title.trim()) throw new ValidationError("Give the issue a title");
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.v.userId } });
  const port = ctx.port ?? (await portForWrite(ctx.db, user, repo));
  const created = await port.createIssue(repo.owner.login, repo.name, { title: input.title.trim(), body: input.body, labels: input.labels });
  await refresh(ctx, port, repo.id, created.number);
  await audit(ctx.db, ctx.v, "github.create-issue", { type: "Repository", id: repo.id }, { number: created.number });
  return created;
}

// ---------- merge ----------

export type MergeEligibility = {
  headSha: string | null;
  baseRef: string | null;
  hardBlockers: string[];
  warnings: string[];
  methods: MergeMethod[];
};

/** Re-fetches from GitHub, never trusts cached eligibility. Unknown mergeability is a blocker with a retry hint. */
export async function mergeEligibility(ctx: Ctx, workItemId: string): Promise<MergeEligibility> {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "review");
  if (item.type !== "PULL_REQUEST") throw new ValidationError("Only pull requests can be merged");
  const fresh = await port.getPull(owner, name, item.number);
  const checks = fresh.headSha ? await port.getChecksState(owner, name, fresh.headSha) : "NONE";
  await refresh(ctx, port, repo.id, item.number);
  const hard: string[] = [];
  const warn: string[] = [];
  if (fresh.state !== "OPEN") hard.push(`This pull request is ${fresh.state.toLowerCase()}`);
  if (fresh.draft) hard.push("Draft pull requests cannot be merged");
  if (fresh.mergeable === "CONFLICTING") hard.push("It has merge conflicts with the base branch");
  if (fresh.mergeable === "UNKNOWN") hard.push("GitHub has not finished computing mergeability. Wait a moment and check again.");
  if (checks === "FAILURE") hard.push("Required checks are failing");
  if (checks === "PENDING") warn.push("Checks are still running");
  if (checks === "UNKNOWN") warn.push("Check status could not be read with your authorization");
  const d = await derivedDetail(ctx.db, ctx.v, item.id);
  if (d.derivation.applicable && !d.derivation.satisfied) warn.push("The review routing rule for this repository is not satisfied yet");
  if (d.ruleConflict) warn.push(d.ruleConflict);
  return { headSha: fresh.headSha ?? null, baseRef: fresh.baseRef ?? null, hardBlockers: hard, warnings: warn, methods: ["squash", "merge", "rebase"] };
}

/**
 * The caller echoes back the head SHA, method and acknowledged warnings they saw. We re-check eligibility again and
 * send the SHA to GitHub, which refuses if the head moved. No bypass of branch protection exists here.
 */
export async function mergePullRequest(ctx: Ctx, workItemId: string, input: { method: MergeMethod; confirmedHeadSha: string; acknowledgeWarnings: boolean }) {
  const { item, repo, port, owner, name } = await load(ctx, workItemId, "review");
  const e = await mergeEligibility({ ...ctx, port }, workItemId);
  if (e.hardBlockers.length) throw new ValidationError(e.hardBlockers[0]);
  if (e.headSha !== input.confirmedHeadSha) throw new ValidationError("The pull request changed after you confirmed. Review the new head commit and confirm again.");
  if (e.warnings.length && !input.acknowledgeWarnings) throw new ValidationError("Acknowledge the warnings to continue");
  const r = await port.mergePull(owner, name, item.number, { method: input.method, expectedHeadSha: input.confirmedHeadSha });
  if (!r.merged) throw new ValidationError(r.message || "GitHub did not merge this pull request");
  await refresh(ctx, port, repo.id, item.number);
  await audit(ctx.db, ctx.v, "github.merge", { type: "WorkItem", id: item.id }, { method: input.method, sha: input.confirmedHeadSha });
}

// ---------- fork sync ----------

/** Confirmed, remote-only fork sync. Re-checks branch heads first; conflicts change nothing. */
export async function syncForkBranch(ctx: Ctx, mappingId: string, confirmed: { forkTip: string; upstreamTip: string }) {
  const map = await ctx.db.forkMapping.findFirst({ where: { id: mappingId }, include: { fork: { include: { owner: true } }, upstream: true } });
  if (!map) throw new NotFoundError();
  const fork = await requireRepo(ctx.db, ctx.v, map.forkRepoId, "manageWork");
  await requireRepo(ctx.db, ctx.v, map.upstreamRepoId, "view"); // upstream content must also be visible
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.v.userId } });
  const port = ctx.port ?? (await portForWrite(ctx.db, user, fork));
  const [fb, ub] = await Promise.all([port.listBranches(fork.owner.login, fork.name), port.listBranches(map.upstream.fullName.split("/")[0], map.upstream.name)]);
  const forkTip = fb.find((b) => b.name === map.forkBranch)?.sha;
  const upTip = ub.find((b) => b.name === map.upstreamBranch)?.sha;
  if (!forkTip || !upTip) throw new ValidationError("A mapped branch no longer exists. Remap the branches first.");
  if (forkTip !== confirmed.forkTip || upTip !== confirmed.upstreamTip) throw new ValidationError("A branch moved since you looked. Refresh the comparison and confirm again.");
  const res = await port.mergeUpstream(fork.owner.login, fork.name, map.forkBranch);
  await audit(ctx.db, ctx.v, "github.sync-fork", { type: "ForkMapping", id: map.id }, { result: res.result });
  return res;
}

export { ForbiddenError };
