import type { RepoMeta } from "@/lib/services/repositories";
import type { CompareOutcome } from "@/lib/domain/forks";
import { GithubError, type Discovery, type GithubPort, type MergeMethod, type Page, type RateInfo, type RemoteBranch, type RemoteComment, type RemoteRequested, type RemoteReview, type RemoteWorkItem } from "./port";

/**
 * In-memory fake GitHub used by tests and by local development without credentials.
 * It is a CONTRACT implementation, not a mock of call counts: sync code runs against it exactly as
 * it would against Octokit. Failure injection lets tests exercise rate limits and permission loss.
 */
export class FakeGithub implements GithubPort {
  readonly mode = "live" as const;
  repos = new Map<string, RepoMeta>();
  items = new Map<string, RemoteWorkItem[]>(); // key owner/repo
  reviews = new Map<string, RemoteReview[]>(); // key owner/repo#n
  comments = new Map<string, RemoteComment[]>();
  requested = new Map<string, RemoteRequested>();
  checks = new Map<string, "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN">();
  branches = new Map<string, RemoteBranch[]>();
  compares = new Map<string, CompareOutcome>();
  ancestors = new Map<string, "ancestor" | "not-ancestor" | "unknown">();
  mergeShas = new Map<string, string>();
  discovery: Discovery = { repos: [], nextPage: null, notes: [] };
  pageSize = 100;
  calls: string[] = [];
  private failures: GithubError[] = [];
  writes: string[] = [];

  failNext(e: GithubError) {
    this.failures.push(e);
  }
  private maybeFail(call: string) {
    this.calls.push(call);
    const f = this.failures.shift();
    if (f) throw f;
  }
  lastRate(): RateInfo | null {
    return null;
  }
  private k = (o: string, r: string) => `${o}/${r}`;
  private kn = (o: string, r: string, n: number) => `${o}/${r}#${n}`;

  async getRepository(owner: string, repo: string) {
    this.maybeFail("getRepository");
    const r = this.repos.get(this.k(owner, repo));
    if (!r) throw new GithubError("not-found", "Not found");
    return r;
  }
  async listAuthorizedRepositories() {
    this.maybeFail("listAuthorizedRepositories");
    return this.discovery;
  }
  async listIssuesAndPulls(owner: string, repo: string, o: { since?: Date; page: number }): Promise<Page<RemoteWorkItem>> {
    this.maybeFail("listIssuesAndPulls");
    if (!this.repos.has(this.k(owner, repo))) throw new GithubError("not-found", "Not found");
    const all = (this.items.get(this.k(owner, repo)) ?? []).filter((i) => !o.since || i.updatedAt >= o.since).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const start = (o.page - 1) * this.pageSize;
    const slice = all.slice(start, start + this.pageSize);
    return { items: slice, nextPage: start + this.pageSize < all.length ? o.page + 1 : null };
  }
  async getPull(owner: string, repo: string, number: number) {
    this.maybeFail("getPull");
    const it = (this.items.get(this.k(owner, repo)) ?? []).find((i) => i.number === number);
    if (!it) throw new GithubError("not-found", "Not found");
    return it;
  }
  async getIssue(owner: string, repo: string, number: number) {
    this.maybeFail("getIssue");
    const it = (this.items.get(this.k(owner, repo)) ?? []).find((i) => i.number === number);
    if (!it) throw new GithubError("not-found", "Not found");
    return it;
  }
  async listReviews(o: string, r: string, n: number) {
    this.maybeFail("listReviews");
    return this.reviews.get(this.kn(o, r, n)) ?? [];
  }
  async listIssueComments(o: string, r: string, n: number) {
    this.maybeFail("listIssueComments");
    return this.comments.get(this.kn(o, r, n)) ?? [];
  }
  reviewComments = new Map<string, import("./port").RemoteComment[]>();
  async listReviewComments(o: string, r: string, n: number) {
    return this.reviewComments.get(this.kn(o, r, n)) ?? [];
  }
  async listRequestedReviewers(o: string, r: string, n: number) {
    this.maybeFail("listRequestedReviewers");
    return this.requested.get(this.kn(o, r, n)) ?? { users: [], teams: [] };
  }
  async getChecksState(o: string, r: string, sha: string) {
    return this.checks.get(`${o}/${r}@${sha}`) ?? "NONE";
  }
  async listBranches(o: string, r: string) {
    this.maybeFail("listBranches");
    return this.branches.get(this.k(o, r)) ?? [];
  }
  async listPullFiles() {
    return { files: [], truncated: false };
  }
  async listPullCommits() {
    return { commits: [], truncated: false };
  }
  async listCommitFiles() {
    return { files: [], truncated: false };
  }
  commitCompares = new Map<string, { files: { filename: string; status: string; additions: number; deletions: number; patch: string | null; previousFilename: string | null }[]; aheadBy: number }>();
  async compareCommits(o: string, r: string, base: string, head: string) {
    this.maybeFail("compareCommits");
    const c = this.commitCompares.get(`${o}/${r}:${base}...${head}`);
    return { files: c?.files ?? [], truncated: false, aheadBy: c?.aheadBy ?? 0 };
  }
  threads = new Map<string, { rootCommentId: bigint; resolved: boolean }[]>();
  async listReviewThreads(o: string, r: string, n: number) {
    this.maybeFail("listReviewThreads");
    return this.threads.get(this.kn(o, r, n)) ?? [];
  }
  /** Files by `owner/repo:ref:path`, for tests that read repository files (CODEOWNERS). */
  files = new Map<string, string>();
  async getContents(o?: string, r?: string, path?: string, ref?: string): Promise<any> {
    const text = this.files.get(`${o}/${r}:${ref}:${path}`);
    if (text !== undefined) return { kind: "file", file: { path, sha: "fake", size: text.length, text, binary: false, tooLarge: false, htmlUrl: null } };
    throw new GithubError("not-found", "Not found", undefined, undefined, 404);
  }
  async createReviewComment(o: string, r: string, n: number, i: { body: string; path: string; line: number }) {
    this.writes.push(`review-comment ${o}/${r}#${n} ${i.path}:${i.line}`);
    return { githubId: 3n, login: null, body: i.body, createdAt: new Date(), updatedAt: new Date() };
  }
  async compare(u: { owner: string; repo: string; branch: string }, f: { owner: string; branch: string }): Promise<CompareOutcome> {
    this.maybeFail("compare");
    return this.compares.get(`${u.owner}/${u.repo}:${u.branch}...${f.owner}:${f.branch}`) ?? { kind: "not-found" };
  }
  async isAncestor(repo: { owner: string; repo: string }, sha: string, tip: string) {
    return this.ancestors.get(`${repo.owner}/${repo.repo}:${sha}...${tip}`) ?? "unknown";
  }
  async getPullMergeSha(o: string, r: string, n: number) {
    return this.mergeShas.get(this.kn(o, r, n)) ?? null;
  }

  // writes just record intent; tests assert on what would have been sent and with whose credential
  async createIssue(o: string, r: string, input: { title: string }) {
    this.writes.push(`createIssue ${o}/${r} ${input.title}`);
    return { githubId: 1n, number: 999, type: "ISSUE" as const, title: input.title, body: null, state: "OPEN" as const, draft: false, authorLogin: null, authorGithubId: null, authorAvatar: null, labels: [], assignees: [], milestoneNumber: null, milestoneTitle: null, htmlUrl: "", createdAt: new Date(), updatedAt: new Date(), closedAt: null, mergedAt: null };
  }
  async createComment(o: string, r: string, n: number, body: string) {
    this.writes.push(`comment ${o}/${r}#${n}`);
    return { githubId: 2n, login: null, body, createdAt: new Date(), updatedAt: new Date() };
  }
  async setLabels(o: string, r: string, n: number, l: string[]) {
    this.writes.push(`labels ${o}/${r}#${n} ${l.join(",")}`);
  }
  async setAssignees(o: string, r: string, n: number, a: string[]) {
    this.writes.push(`assignees ${o}/${r}#${n} ${a.join(",")}`);
  }
  async setMilestone(o: string, r: string, n: number, m: number | null) {
    this.writes.push(`milestone ${o}/${r}#${n} ${m}`);
  }
  async requestReviewers(o: string, r: string, n: number) {
    this.writes.push(`request ${o}/${r}#${n}`);
  }
  async submitReview(o: string, r: string, n: number, i: { event: string; comments?: unknown[] }) {
    this.writes.push(`review ${o}/${r}#${n} ${i.event}${i.comments?.length ? ` +${i.comments.length} comments` : ""}`);
  }
  async mergePull(o: string, r: string, n: number, i: { method: MergeMethod; expectedHeadSha: string }) {
    this.maybeFail("mergePull");
    this.writes.push(`merge ${o}/${r}#${n} ${i.method} ${i.expectedHeadSha}`);
    return { merged: true, message: "merged" };
  }
  async mergeUpstream(o: string, r: string, b: string) {
    this.writes.push(`merge-upstream ${o}/${r}:${b}`);
    return { result: "merged" as const, message: "ok" };
  }
}
