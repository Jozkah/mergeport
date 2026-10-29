import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import type { RepoMeta } from "@/lib/services/repositories";
import type { CompareOutcome } from "@/lib/domain/forks";
import { sameLogin, indexList } from "@/lib/domain/text-index";
import { GithubError, type GithubPort, type MergeMethod, type Page, type RemoteBranch, type RemoteComment, type RemoteRequested, type RemoteReview, type RemoteWorkItem } from "./port";

/**
 * Demo-mode GitHub. The seeded database IS the demo "remote": reads reflect it and writes persist into it,
 * so demo interactions survive refresh and are visible to every demo session. It only ever serves repositories
 * flagged isDemo and is never selected for a live repository.
 */

const COLORS: Record<string, string> = { bug: "d73a4a", enhancement: "a2eeef", documentation: "0075ca", "needs-maintainer-review": "fbca04" };
let seq = 0n;
const nextId = () => BigInt(Date.now()) * 1000n + (seq++ % 1000n);

export class DemoPort implements GithubPort {
  readonly mode = "demo" as const;
  constructor(
    private readonly db: Db,
    private readonly actingLogin: string,
  ) {}
  lastRate() {
    return null;
  }

  private async repo(owner: string, name: string) {
    const r = await this.db.repository.findFirst({ where: { fullName: `${owner}/${name}`, isDemo: true }, include: { owner: true } });
    if (!r) throw new GithubError("not-found", "Not found");
    return r;
  }
  private async item(owner: string, name: string, number: number) {
    const r = await this.repo(owner, name);
    const i = await this.db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: r.id, number } } });
    if (!i) throw new GithubError("not-found", "Not found");
    return { r, i };
  }
  private toRemote(i: Prisma.WorkItemGetPayload<object>): RemoteWorkItem {
    return {
      githubId: i.githubId, number: i.number, type: i.type, title: i.title, body: i.body, state: i.state, draft: i.draft,
      authorLogin: i.authorLogin, authorGithubId: i.authorGithubId, authorAvatar: i.authorAvatar,
      labels: (i.labels as unknown as { name: string; color: string }[]) ?? [], assignees: (i.assignees as unknown as string[]) ?? [],
      milestoneNumber: i.milestoneNumber, milestoneTitle: i.milestoneTitle, htmlUrl: i.htmlUrl, createdAt: i.createdAtGh, updatedAt: i.updatedAtGh,
      closedAt: i.closedAtGh, mergedAt: i.mergedAtGh, headSha: i.headSha, headRef: i.headRef, baseRef: i.baseRef, mergeable: i.mergeable,
      additions: i.additions, deletions: i.deletions, changedFiles: i.changedFiles,
    };
  }
  private touch(id: string) {
    return this.db.workItem.update({ where: { id }, data: { updatedAtGh: new Date() } });
  }

  async getRepository(owner: string, name: string): Promise<RepoMeta> {
    const r = await this.repo(owner, name);
    return {
      githubId: r.githubId, fullName: r.fullName, name: r.name, htmlUrl: r.htmlUrl, description: r.description, visibility: r.visibility, isFork: r.isFork,
      parentGithubId: r.parentGithubId, parentFullName: r.parentFullName, defaultBranch: r.defaultBranch, archived: r.archived,
      owner: { githubId: r.owner.githubId, login: r.owner.login, type: r.owner.type, avatarUrl: r.owner.avatarUrl },
    };
  }
  async listAuthorizedRepositories() {
    const rs = await this.db.repository.findMany({ where: { isDemo: true }, include: { owner: true } });
    return { repos: rs.map((r) => ({ githubId: r.githubId, fullName: r.fullName, name: r.name, htmlUrl: r.htmlUrl, description: r.description, visibility: r.visibility, isFork: r.isFork, parentGithubId: r.parentGithubId, parentFullName: r.parentFullName, defaultBranch: r.defaultBranch, archived: r.archived, owner: { githubId: r.owner.githubId, login: r.owner.login, type: r.owner.type } })), nextPage: null, notes: [] };
  }
  async listIssuesAndPulls(owner: string, name: string): Promise<Page<RemoteWorkItem>> {
    const r = await this.repo(owner, name);
    const rows = await this.db.workItem.findMany({ where: { repositoryId: r.id } });
    return { items: rows.map((i) => this.toRemote(i)), nextPage: null };
  }
  async getPull(owner: string, name: string, number: number) {
    return this.toRemote((await this.item(owner, name, number)).i);
  }
  async listReviews(owner: string, name: string, number: number): Promise<RemoteReview[]> {
    const { i } = await this.item(owner, name, number);
    const rows = await this.db.workItemComment.findMany({ where: { workItemId: i.id, kind: "REVIEW" } });
    return rows.map((c) => ({ githubId: c.githubId, login: c.authorLogin, state: c.reviewState ?? "COMMENTED", body: c.body, commitSha: c.commitSha, submittedAt: c.createdAtGh }));
  }
  async listIssueComments(owner: string, name: string, number: number): Promise<RemoteComment[]> {
    const { i } = await this.item(owner, name, number);
    const rows = await this.db.workItemComment.findMany({ where: { workItemId: i.id, kind: "ISSUE_COMMENT" } });
    return rows.map((c) => ({ githubId: c.githubId, login: c.authorLogin, body: c.body, createdAt: c.createdAtGh, updatedAt: c.updatedAtGh }));
  }
  async listReviewComments() {
    return [];
  }
  async listRequestedReviewers(owner: string, name: string, number: number): Promise<RemoteRequested> {
    const { i } = await this.item(owner, name, number);
    const rows = await this.db.reviewRequest.findMany({ where: { workItemId: i.id, removedAt: null } });
    return { users: rows.filter((r) => r.kind === "USER").map((r) => r.reviewerRef), teams: rows.filter((r) => r.kind === "TEAM").map((r) => r.reviewerRef) };
  }
  async getChecksState(owner: string, name: string) {
    void owner; void name;
    return "SUCCESS" as const;
  }
  async listBranches(owner: string, name: string): Promise<RemoteBranch[]> {
    const r = await this.repo(owner, name);
    return (await this.db.branch.findMany({ where: { repositoryId: r.id } })).map((b) => ({ name: b.name, sha: b.sha, isDefault: b.isDefault }));
  }
  async listPullFiles() {
    return {
      files: [
        { filename: "src/example/demo.ts", status: "modified", additions: 12, deletions: 3, patch: ["@@ -1,5 +1,14 @@", " import { thing } from './thing';", "-const old = 1;", "+const next = 2; // synthetic demo diff", "+export function demo() {", "+  return next;", "+}"].join("\n") },
      ],
      truncated: false,
    };
  }
  async listPullCommits() {
    return { commits: [{ sha: "d3m0c0m1", message: "Synthetic demo commit", author: "demo-author", date: new Date() }], truncated: false };
  }
  async compare(): Promise<CompareOutcome> {
    return { kind: "error", message: "Demo mode serves the stored comparison; it does not recompute one." };
  }
  async isAncestor() {
    return "unknown" as const;
  }
  async getPullMergeSha() {
    return null;
  }

  // ---------- writes ----------
  async createIssue(owner: string, name: string, input: { title: string; body?: string; labels?: string[] }) {
    const r = await this.repo(owner, name);
    const max = await this.db.workItem.aggregate({ where: { repositoryId: r.id }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    const now = new Date();
    const i = await this.db.workItem.create({
      data: { repositoryId: r.id, githubId: nextId(), number, type: "ISSUE", title: input.title, body: input.body ?? null, authorLogin: this.actingLogin, labels: (input.labels ?? []).map((l) => ({ name: l, color: COLORS[l] ?? "ededed" })), labelNames: indexList(input.labels ?? []), htmlUrl: `${r.htmlUrl}/issues/${number}`, createdAtGh: now, updatedAtGh: now },
    });
    return this.toRemote(i);
  }
  async createComment(owner: string, name: string, number: number, body: string): Promise<RemoteComment> {
    const { i } = await this.item(owner, name, number);
    const now = new Date();
    const c = await this.db.workItemComment.create({ data: { workItemId: i.id, githubId: nextId(), kind: "ISSUE_COMMENT", authorLogin: this.actingLogin, body, createdAtGh: now, updatedAtGh: now } });
    await this.touch(i.id);
    return { githubId: c.githubId, login: c.authorLogin, body: c.body, createdAt: now, updatedAt: now };
  }
  async setLabels(owner: string, name: string, number: number, labels: string[]) {
    const { i } = await this.item(owner, name, number);
    await this.db.workItem.update({ where: { id: i.id }, data: { labels: labels.map((l) => ({ name: l, color: COLORS[l] ?? "ededed" })), labelNames: indexList(labels), updatedAtGh: new Date() } });
  }
  async setAssignees(owner: string, name: string, number: number, assignees: string[]) {
    const { i } = await this.item(owner, name, number);
    await this.db.workItem.update({ where: { id: i.id }, data: { assignees, assigneeLogins: indexList(assignees), updatedAtGh: new Date() } });
  }
  async setMilestone(owner: string, name: string, number: number, milestoneNumber: number | null) {
    const { i } = await this.item(owner, name, number);
    await this.db.workItem.update({ where: { id: i.id }, data: { milestoneNumber, milestoneTitle: milestoneNumber ? `Milestone ${milestoneNumber}` : null, updatedAtGh: new Date() } });
  }
  async requestReviewers(owner: string, name: string, number: number, r: { users?: string[]; teams?: string[] }) {
    const { i } = await this.item(owner, name, number);
    const now = new Date();
    for (const u of r.users ?? []) await this.db.reviewRequest.create({ data: { workItemId: i.id, kind: "USER", reviewerRef: u, requestedAt: now } });
    for (const t of r.teams ?? []) await this.db.reviewRequest.create({ data: { workItemId: i.id, kind: "TEAM", reviewerRef: t, requestedAt: now } });
    await this.touch(i.id);
  }
  async submitReview(owner: string, name: string, number: number, input: { event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; body?: string; commitSha?: string }) {
    const { i } = await this.item(owner, name, number);
    const now = new Date();
    const state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    await this.db.workItemComment.create({ data: { workItemId: i.id, githubId: nextId(), kind: "REVIEW", authorLogin: this.actingLogin, reviewState: state, commitSha: input.commitSha ?? i.headSha, body: input.body ?? null, createdAtGh: now, updatedAtGh: now } });
    if (state !== "COMMENTED") {
      const open = await this.db.reviewRequest.findMany({ where: { workItemId: i.id, removedAt: null } });
      const mine = open.filter((r) => sameLogin(r.reviewerRef, this.actingLogin)).map((r) => r.id);
      if (mine.length) await this.db.reviewRequest.updateMany({ where: { id: { in: mine } }, data: { removedAt: now } });
    }
    await this.touch(i.id);
  }
  async mergePull(owner: string, name: string, number: number, input: { method: MergeMethod; expectedHeadSha: string }) {
    const { i } = await this.item(owner, name, number);
    if (i.state !== "OPEN") throw new GithubError("unknown", "405: Pull request is not mergeable");
    if (i.headSha !== input.expectedHeadSha) throw new GithubError("unknown", "409: Head branch was modified. Review and try the merge again.");
    const now = new Date();
    await this.db.workItem.update({ where: { id: i.id }, data: { state: "MERGED", mergedAtGh: now, closedAtGh: now, updatedAtGh: now } });
    return { merged: true, message: "Pull request successfully merged (demo)" };
  }
  async mergeUpstream(owner: string, name: string, branch: string) {
    const r = await this.repo(owner, name);
    const map = await this.db.forkMapping.findFirst({ where: { forkRepoId: r.id, forkBranch: branch } });
    if (!map) throw new GithubError("not-found", "Not found");
    const last = await this.db.forkComparison.findFirst({ where: { mappingId: map.id }, orderBy: { comparedAt: "desc" } });
    if (last && (last.aheadBy ?? 0) > 0 && (last.behindBy ?? 0) > 0) return { result: "conflict" as const, message: "The fork has its own commits and the demo branches conflict; nothing was changed." };
    await this.db.forkComparison.create({ data: { mappingId: map.id, status: "identical", aheadBy: 0, behindBy: 0, baseSha: last?.baseSha, headSha: last?.baseSha } });
    return { result: "fast-forward" as const, message: "Fork branch fast-forwarded (demo)" };
  }
}
