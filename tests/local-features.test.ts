import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { moveCard, requestManualReview, resolveManualReview } from "@/lib/services/planning";
import { mapLocalRoot, scanWorktrees, worktreesFor } from "@/lib/services/worktrees";
import { removeFromTracking } from "@/lib/services/repositories";
import { freshSeed, leaks } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("planning concurrency on this computer", () => {
  it("a stale version is refused and the card is not moved; the winner's move stands", async () => {
    const { db, a, ids } = S;
    const id = ids.cards.cWeb.id;
    const before = await db.planningItem.findUniqueOrThrow({ where: { id } });
    const first = await moveCard(db, a, { itemId: id, toColumnKey: "done", expectedVersion: before.version });
    expect(first.version).toBeGreaterThan(before.version);
    await expect(moveCard(db, a, { itemId: id, toColumnKey: "ready", expectedVersion: before.version })).rejects.toBeInstanceOf(ConflictError);
    const after = await db.planningItem.findUniqueOrThrow({ where: { id }, include: { column: true } });
    expect(after.column.key).toBe("done");
  });

  it("two racing moves with the same version: exactly one wins", async () => {
    const { db, a, ids } = S;
    const id = ids.cards.cWeb.id;
    const v = (await db.planningItem.findUniqueOrThrow({ where: { id } })).version;
    const results = await Promise.allSettled([moveCard(db, a, { itemId: id, toColumnKey: "done", expectedVersion: v }), moveCard(db, a, { itemId: id, toColumnKey: "ready", expectedVersion: v })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("manual waiting", () => {
  it("only the named reviewer or an administrator can decide, and the record is cleared with a reason", async () => {
    const { db, admin, a, b, ids } = S;
    const rec = await requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "USER", reviewerRef: "bram-demo", reason: "Needs design sign-off" });
    await expect(resolveManualReview(db, a, rec.id, "SATISFIED", "self-approve")).rejects.toBeInstanceOf(ForbiddenError);
    await resolveManualReview(db, b, rec.id, "SATISFIED", "looks good");
    const done = await db.waitingRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(done).toMatchObject({ status: "SATISFIED", clearReason: "looks good" });
    const second = await requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "EXTERNAL_ROLE", reviewerRef: "legal", reason: "Licence check" });
    await resolveManualReview(db, admin, second.id, "CANCELLED", "no longer needed");
    await expect(resolveManualReview(db, admin, second.id, "CANCELLED", "again")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires a reason", async () => {
    const { db, a, ids } = S;
    await expect(requestManualReview(db, a, { workItemId: ids.items.web10.id, reviewerKind: "USER", reviewerRef: "x", reason: "  " })).rejects.toThrow(/why/i);
  });
});

describe("local worktree scan", () => {
  let tmp: string;
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-wt-"));
    repoDir = path.join(tmp, "work");
    fs.mkdirSync(repoDir);
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repoDir, "a.txt"), "one");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repoDir, ".env"), "TOKEN=top-secret-value");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("keeps the snapshot on this computer, with counts only and no file contents", async () => {
    const { db, a, ids } = S;
    await mapLocalRoot(db, a, ids.repos.web.id, repoDir);
    await scanWorktrees(db, a, ids.repos.web.id);
    const view = await worktreesFor(db, a, ids.repos.web.id);
    expect(view?.worktrees[0].branch).toBe("main");
    expect(leaks(view, "top-secret-value")).toBe(false);
    expect(leaks(await db.worktreeSnapshot.findMany(), "top-secret-value")).toBe(false);
    // Nothing about a folder ever enters the outbox that is sent to a shared repository.
    expect(await db.outboxOp.count()).toBe(0);
  });

  it("cannot map or scan a repository the person cannot see", async () => {
    const { db, b, ids } = S;
    await expect(mapLocalRoot(db, b, ids.repos.internal.id, repoDir)).rejects.toBeInstanceOf(NotFoundError);
    await expect(scanWorktrees(db, b, ids.repos.internal.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("untracking a repository forgets its folder and snapshot", async () => {
    const { db, admin, a, ids } = S;
    await mapLocalRoot(db, a, ids.repos.web.id, repoDir);
    await scanWorktrees(db, a, ids.repos.web.id);
    expect(await db.worktreeSnapshot.count({ where: { repositoryId: ids.repos.web.id } })).toBe(1);
    await removeFromTracking(db, admin, ids.repos.web.id);
    expect(await db.worktreeSnapshot.count({ where: { repositoryId: ids.repos.web.id } })).toBe(0);
    expect(await db.deviceRepoMapping.count({ where: { repositoryId: ids.repos.web.id } })).toBe(0);
  });
});
