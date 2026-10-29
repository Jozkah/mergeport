import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrisma } from "@/lib/db";
import { defaultGhRunner } from "@/lib/github/exec";
import { discoverAll, ghPort } from "@/lib/github/factory";
import { ghFetch } from "@/lib/github/gh";
import { GithubError } from "@/lib/github/port";
import { GitHubRest } from "@/lib/github/rest";
import { ensureLocalProfile } from "@/lib/local/profile";
import { profileRunner } from "@/lib/local/profile-runner";

/**
 * OPT-IN, READ-ONLY smoke test against real GitHub through the application's own pinned-identity adapter.
 *   MERGEPORT_LIVE=1 MERGEPORT_LIVE_REPORT=<file> npx vitest run tests/live
 * It uses the GitHub CLI session that already exists. It never logs in, never switches the selected account, and sends
 * only GET requests (the adapter used here exposes no write in this file). Private repositories are only COUNTED during
 * discovery: their names are never printed or written to the report. Nothing token-shaped is allowed into the report.
 */
const live = process.env.MERGEPORT_LIVE === "1";
vi.setConfig({ testTimeout: 180_000 }); // each real `gh` call takes about a second
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-live-"));
const dbs: { $disconnect(): Promise<void> }[] = [];

async function profile(id: bigint, login: string) {
  const db = createPrisma(path.join(tmp, `p-${id}-${dbs.length}.db`));
  dbs.push(db);
  await ensureLocalProfile(db, { id, login, name: login, avatarUrl: null, host: "github.com" });
  return db;
}

afterAll(async () => {
  await Promise.all(dbs.map((d) => d.$disconnect()));
  fs.rmSync(tmp, { recursive: true, force: true });
  const text = JSON.stringify(report, null, 2);
  if (/gh[opsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/.test(text)) throw new Error("A token-shaped string reached the report; refusing to write it");
  if (process.env.MERGEPORT_LIVE_REPORT) fs.writeFileSync(process.env.MERGEPORT_LIVE_REPORT, text);
});

describe.skipIf(!live)("live GitHub, read-only", () => {
  let id: bigint;
  let login: string;

  it("the pinned identity matches the numeric id of the signed-in account", async () => {
    // Who is signed in right now (a read of the public `user` endpoint through the CLI; no token is requested here).
    const who = await defaultGhRunner(["api", "--hostname", "github.com", "user"], { timeoutMs: 20_000 });
    expect(who.code).toBe(0);
    const u = JSON.parse(who.stdout) as { id: number; login: string };
    id = BigInt(u.id);
    login = u.login;
    const db = await profile(id, login);
    const res = await ghFetch(profileRunner(db))("https://api.github.com/user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(BigInt(body.id)).toBe(id);
    report.identity = { pinnedIdMatches: true, status: res.status };
  });

  it("a profile pinned to a DIFFERENT id is blocked, nothing is sent as the signed-in account", async () => {
    const wrong = await profile(id + 1n, login);
    const res = await ghFetch(profileRunner(wrong))("https://api.github.com/repos/cli/cli");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-mergeport-identity")).toBe("mismatch");
    report.mismatchBlocked = { status: res.status, reason: res.headers.get("x-mergeport-identity") };
  });

  it("public repository metadata, issues, pull requests, reviews and branches", async () => {
    const db = await profile(id, login);
    const port = ghPort(db);
    const repo = await port.getRepository("cli", "cli");
    expect(repo.fullName).toBe("cli/cli");
    expect(repo.visibility).toBe("PUBLIC");
    const page = await port.listIssuesAndPulls("cli", "cli", { page: 1 });
    expect(page.items.length).toBeGreaterThan(0);
    const prs = page.items.filter((i) => i.type === "PULL_REQUEST");
    expect(prs.length).toBeGreaterThan(0);
    let reviewed = 0;
    let reviews = 0;
    for (const pr of prs.slice(0, 15)) {
      const rs = await port.listReviews("cli", "cli", pr.number);
      if (rs.length) {
        reviewed++;
        reviews += rs.length;
        if (reviewed === 1) {
          expect(rs[0].state).toBeTruthy();
          const detail = await port.getPull("cli", "cli", pr.number);
          expect(detail.headSha).toBeTruthy();
        }
      }
    }
    const branches = await port.listBranches("cli", "cli");
    expect(branches.length).toBeGreaterThan(0);
    report.publicRepo = { repo: repo.fullName, defaultBranch: repo.defaultBranch, itemsOnPage1: page.items.length, prsOnPage1: prs.length, prsWithReviews: reviewed, reviewsSeen: reviews, branches: branches.length, hasNextPage: page.nextPage !== null };
  });

  it("repository discovery and pagination (counts only, no names)", async () => {
    const db = await profile(id, login);
    const d = await discoverAll(ghPort(db), 3);
    const byVisibility = { PUBLIC: 0, PRIVATE: 0, INTERNAL: 0 } as Record<string, number>;
    for (const r of d.repos) byVisibility[r.visibility] = (byVisibility[r.visibility] ?? 0) + 1;
    expect(d.repos.length).toBeGreaterThan(0);
    // Pagination over REAL Link headers: the client forces 100 per page and follows rel="next"; stop after 3 pages.
    const rest = new GitHubRest(ghFetch(profileRunner(db)));
    const items = await rest.paginate<{ number: number }>("/repos/cli/cli/issues?state=all", 3);
    const unique = new Set(items.map((i) => i.number));
    expect(items.length).toBe(300);
    expect(unique.size).toBe(300);
    report.discovery = { repositoriesListed: d.repos.length, byVisibility, notes: d.notes.length, stoppedBecauseMorePages: d.nextPage !== null };
    report.pagination = { pagesFollowed: 3, itemsPerPage: 100, itemsCollected: items.length, allUnique: unique.size === items.length };
  });

  it("rate-limit headers, conditional requests and error handling", async () => {
    const db = await profile(id, login);
    const f = ghFetch(profileRunner(db));
    const first = await f("https://api.github.com/repos/cli/cli");
    const rate = { limit: first.headers.get("x-ratelimit-limit"), remaining: first.headers.get("x-ratelimit-remaining"), reset: first.headers.get("x-ratelimit-reset"), resource: first.headers.get("x-ratelimit-resource"), used: first.headers.get("x-ratelimit-used") };
    expect(Number(rate.limit)).toBeGreaterThan(0);
    expect(Number(rate.remaining)).toBeGreaterThanOrEqual(0);
    expect(Number(rate.reset)).toBeGreaterThan(Date.now() / 1000 - 60);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await f("https://api.github.com/repos/cli/cli", { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
    const port = ghPort(db);
    await port.getRepository("cli", "cli");
    expect(port.lastRate()?.limit).toBeGreaterThan(0);
    // errors
    const rest = new GitHubRest(f);
    const notFound = await rest.get("/repos/cli/this-repository-does-not-exist-mergeport").catch((e) => e);
    expect(notFound).toBeInstanceOf(GithubError);
    expect((notFound as GithubError).kind).toBe("not-found");
    const bad = await port.getPull("cli", "cli", 999999999).catch((e) => e);
    expect(bad).toBeInstanceOf(GithubError);
    const rl = await rest.get("/rate_limit");
    const core = (rl.data as { resources: { core: { limit: number; remaining: number } } }).resources.core;
    report.rateLimit = { headers: rate, conditionalRequestStatus: second.status, errorMapping: { missingRepo: (notFound as GithubError).kind, missingPull: (bad as GithubError).kind }, coreAfter: { limit: core.limit, remaining: core.remaining } };
  });
});
