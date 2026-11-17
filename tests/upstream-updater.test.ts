import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { runUpdate, updaterDir } from "@/lib/local/upstream-updater";
import { World, depsFor, git, setupMapping } from "./updater-world";
import { testDb } from "./helpers";

vi.setConfig({ testTimeout: 60_000 });
const db = testDb();
let w: World;
let port: FakeGithub;
beforeEach(() => {
  w = new World();
  port = new FakeGithub();
});
afterEach(() => w.destroy());

const SYNC = "mergeport/upstream-sync";
const PASS = `process.exit(0)`;
const clone = (mappingId: string) => `${w.home}/updater/${mappingId}/repo`;
const pulls = () => port.pulls.filter((p) => p.repo === "proj");

describe("upstream updater: pr mode", () => {
  it("clean merge + verify pass pushes ONLY the sync branch and opens one pull request; a second run updates it", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `const fs=require("fs");if(!fs.existsSync("up1.txt")||!fs.existsSync("fork-only.txt")||process.env.CI!=="1"||process.env.GH_TOKEN||process.env.MERGEPORT_DB)process.exit(7);`) });
    w.commitFork({ "fork-only.txt": "ours\n" }, "our patch");
    const up = w.commitUpstream({ "up1.txt": "one\n" }, "feat: one", "Alice Upstream");
    const mainBefore = w.tip(w.fork)!;
    const upstreamBefore = git(w.upstream, "for-each-ref");
    process.env.GH_TOKEN = "must-not-reach-verify";
    let run;
    try {
      run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    } finally {
      delete process.env.GH_TOKEN;
    }
    expect(run.state).toBe("pr-opened");
    expect(run.upstreamSha).toBe(up);
    expect(run.triedShas).toEqual([up]);
    expect(run.prUrl).toBe("https://github.com/owner/proj/pull/1");
    expect(run.commits).toEqual([{ sha: up, subject: "feat: one", author: "Alice Upstream", url: `https://github.com/upstream/proj/commit/${up}` }]);
    // exactly one new branch on the fork, the fork branch itself untouched, upstream untouched
    expect(w.branches(w.fork)).toEqual(["main", SYNC]);
    expect(w.tip(w.fork)).toBe(mainBefore);
    expect(git(w.upstream, "for-each-ref")).toBe(upstreamBefore);
    // the pushed branch is a real merge of our branch and the upstream commit
    const sync = w.tip(w.fork, SYNC)!;
    expect(git(w.fork, "rev-list", "--parents", "-n", "1", sync).split(" ")).toEqual([sync, mainBefore, up]);
    expect(w.show(w.fork, SYNC, "up1.txt")).toBe("one");
    expect(w.show(w.fork, SYNC, "fork-only.txt")).toBe("ours");
    expect(pulls()).toHaveLength(1);
    expect(pulls()[0]).toMatchObject({ head: SYNC, base: "main" });
    expect(pulls()[0].body).toContain("The verify command passed");
    expect(pulls()[0].body).toContain("feat: one");

    // idempotent: the same pull request is updated, not duplicated
    w.commitUpstream({ "up2.txt": "two\n" }, "feat: two");
    const second = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(second.state).toBe("pr-opened");
    expect(second.prUrl).toBe(run.prUrl);
    expect(pulls()).toHaveLength(1);
    expect(port.writes.filter((x) => x.startsWith("pull-create"))).toHaveLength(1);
    expect(port.writes.filter((x) => x.startsWith("pull-update"))).toHaveLength(1);
    expect(w.branches(w.fork)).toEqual(["main", SYNC]);
    expect(w.show(w.fork, SYNC, "up2.txt")).toBe("two");
    expect(pulls()[0].body).toContain("feat: two");
  });

  it("with no verify command the result is merged-untested and says so (pull request only)", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("merged-untested");
    expect(run.prUrl).toBeTruthy();
    expect(pulls()[0].body).toContain("Not tested");
    expect(w.branches(w.fork)).toEqual(["main", SYNC]);
  });

  it("a sync branch that someone else moved after our fetch is not overwritten: the run fails instead", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    await runUpdate(depsFor(w, db, port), s.mapping.id); // creates the sync branch
    const other = `${w.root}/other`;
    git(w.root, "clone", w.fork, other);
    git(other, "checkout", SYNC);
    w.commitUpstream({ "b.txt": "b\n" }, "feat: b");
    let hooked = false;
    const hook = async (step: string) => {
      if (step !== "fetched" || hooked) return;
      hooked = true;
      fs.writeFileSync(`${other}/y.txt`, "y");
      git(other, "add", "-A");
      git(other, "commit", "-m", "someone else, after our fetch");
      git(other, "push", "origin", SYNC);
    };
    const run = (await runUpdate(depsFor(w, db, port, { afterStep: hook }), s.mapping.id))!;
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/refused/);
    expect(git(w.fork, "log", "-1", "--format=%s", SYNC)).toBe("someone else, after our fetch");
  });
});

describe("upstream updater: push mode", () => {
  it("refuses to run without a verify command and changes nothing", async () => {
    const s = await setupMapping(db, { promote: "push", verifyCommand: null });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    const before = w.tip(w.fork);
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/needs a verify command/);
    expect(w.tip(w.fork)).toBe(before);
    expect(w.branches(w.fork)).toEqual(["main"]);
    expect(pulls()).toHaveLength(0);
  });

  it("fast-forwards the fork branch only after verify passed; the sync branch and any pull request are not involved", async () => {
    const s = await setupMapping(db, { promote: "push", verifyCommand: w.script("v", PASS) });
    const up = w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    const before = w.tip(w.fork)!;
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("promoted");
    const after = w.tip(w.fork)!;
    expect(after).not.toBe(before);
    expect(w.isAncestor(w.fork, before, after)).toBe(true); // a fast-forward: nothing rewritten
    expect(w.isAncestor(w.fork, up, after)).toBe(true);
    expect(w.branches(w.fork)).toEqual(["main"]);
    expect(pulls()).toHaveLength(0);
    expect(w.tip(w.upstream)).toBe(up);
  });

  it("does not push when verify fails", async () => {
    const s = await setupMapping(db, { promote: "push", verifyCommand: w.script("v", `process.exit(1)`) });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    const before = w.tip(w.fork);
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("verify-failed");
    expect(w.tip(w.fork)).toBe(before);
    expect(w.branches(w.fork)).toEqual(["main"]);
  });

  it("a fork branch that moved during the run makes the plain push fail instead of being forced", async () => {
    const s = await setupMapping(db, { promote: "push", verifyCommand: w.script("v", PASS) });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    let moved: string | null = null;
    const run = (await runUpdate(depsFor(w, db, port, { afterStep: (step) => { if (step === "verified" && !moved) moved = w.commitFork({ "late.txt": "late\n" }, "pushed meanwhile"); } }), s.mapping.id))!;
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/refused/);
    expect(w.tip(w.fork)).toBe(moved); // their commit is still the tip
  });
});

describe("upstream updater: conflicts, fallbacks, restarts, timeouts", () => {
  it("a conflict aborts cleanly, records the files, pushes nothing and leaves a reusable clone", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", PASS) });
    w.commitFork({ "base.txt": "line1\nOURS\nline3\n" }, "our change");
    w.commitUpstream({ "base.txt": "line1\nTHEIRS\nline3\n" }, "upstream change");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("conflict");
    expect(run.filesConflicted).toEqual(["base.txt"]);
    expect(w.branches(w.fork)).toEqual(["main"]);
    expect(pulls()).toHaveLength(0);
    const c = clone(s.mapping.id);
    expect(git(c, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(`${c}/.git/MERGE_HEAD`)).toBe(false);
    // the same clone serves the next run (no new clone: its marker file survives)
    fs.writeFileSync(`${c}/.git/mp-marker`, "kept");
    const again = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(again.state).toBe("conflict");
    expect(fs.readFileSync(`${c}/.git/mp-marker`, "utf8")).toBe("kept");
  });

  it("a damaged scratch clone is replaced (only inside the updater folder)", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    await runUpdate(depsFor(w, db, port), s.mapping.id);
    fs.rmSync(`${clone(s.mapping.id)}/.git/HEAD`);
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("merged-untested");
  });

  it("verify failure falls back to the next older upstream commit and records every sha tried", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `if(require("fs").existsSync("bad.txt"))process.exit(1)`) });
    const good = w.commitUpstream({ "good.txt": "g\n" }, "feat: good");
    const bad = w.commitUpstream({ "bad.txt": "b\n" }, "feat: bad");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("pr-opened");
    expect(run.upstreamSha).toBe(bad);
    expect(run.triedShas).toEqual([bad, good]);
    expect(w.show(w.fork, SYNC, "good.txt")).toBe("g");
    expect(w.show(w.fork, SYNC, "bad.txt")).toBeNull();
    expect((run.commits as { sha: string }[]).map((c) => c.sha)).toEqual([good]);
    expect(pulls()[0].body).toContain("conflicted or failed verification");
  });

  it("a conflict at the head also falls back to an older commit that merges", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitFork({ "base.txt": "line1\nOURS\nline3\n" }, "our change");
    const ok = w.commitUpstream({ "fine.txt": "f\n" }, "feat: fine");
    const clash = w.commitUpstream({ "base.txt": "line1\nTHEIRS\nline3\n" }, "feat: clash");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("merged-untested");
    expect(run.triedShas).toEqual([clash, ok]);
  });

  it("gives up after MAX_BACK older commits (7 candidates in all) with verify-failed", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `process.exit(1)`) });
    const shas: string[] = [];
    for (let i = 0; i < 10; i++) shas.push(w.commitUpstream({ [`f${i}.txt`]: `${i}\n` }, `c${i}`));
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("verify-failed");
    expect(run.triedShas).toEqual(shas.slice(-7).reverse());
    expect(w.branches(w.fork)).toEqual(["main"]);
    expect(pulls()).toHaveLength(0);
  });

  it("stops at the commit the fork already contains", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `process.exit(1)`) });
    const a = w.commitUpstream({ "a.txt": "a\n" }, "a");
    w.commitUpstream({ "b.txt": "b\n" }, "b");
    // the fork already has `a`
    git(`${w.root}/wf`, "fetch", w.upstream, "main");
    git(`${w.root}/wf`, "merge", "--no-edit", a);
    git(`${w.root}/wf`, "push", "origin", "main");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("verify-failed");
    expect(run.triedShas).toHaveLength(1); // only `b`: nothing below what the fork has
  });

  it("a newer upstream head arriving mid-run restarts the attempt on it", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", PASS) });
    const first = w.commitUpstream({ "a.txt": "a\n" }, "feat: a");
    let newer = "";
    let fired = false;
    const run = (await runUpdate(depsFor(w, db, port, { afterStep: (step) => { if (step === "merged" && !fired) { fired = true; newer = w.commitUpstream({ "b.txt": "b\n" }, "feat: b"); } } }), s.mapping.id))!;
    expect(run.state).toBe("pr-opened");
    expect(run.upstreamSha).toBe(newer);
    const tried = run.triedShas as string[];
    expect(tried[0]).toBe(first);
    expect(tried.at(-1)).toBe(newer);
    expect(w.show(w.fork, SYNC, "b.txt")).toBe("b");
    expect(run.logTail).toContain("newer upstream commit");
  });

  it("a verify that exceeds the time limit is killed, recorded as such, and no older commit is tried", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `require("fs").writeFileSync(${JSON.stringify(`${w.root}/pid.txt`)}, String(process.pid)); setInterval(()=>{},1000)`), timeoutSec: 2 });
    w.commitUpstream({ "a.txt": "a\n" }, "a");
    w.commitUpstream({ "b.txt": "b\n" }, "b");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("verify-failed");
    expect(run.error).toMatch(/timed out after 2 s/);
    expect(run.triedShas).toHaveLength(1);
    const pid = Number(fs.readFileSync(`${w.root}/pid.txt`, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
    expect(w.branches(w.fork)).toEqual(["main"]);
  }, 30_000);

  it("turning auto-update off during a run cancels it between steps", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", PASS) });
    w.commitUpstream({ "a.txt": "a\n" }, "a");
    const run = (await runUpdate(depsFor(w, db, port, { afterStep: async (step) => { if (step === "merged") await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { enabled: false } }); } }), s.mapping.id))!;
    expect(run.state).toBe("cancelled");
    expect(w.branches(w.fork)).toEqual(["main"]);
  });

  it("a missing upstream branch is a failure with a clear message (and nothing is pushed)", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    await db.forkMapping.update({ where: { id: s.mapping.id }, data: { upstreamBranch: "nope" } });
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/nope was not found/);
  });
});

describe("upstream updater: reporting", () => {
  it("up-to-date records one row per upstream sha and creates no notification", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    const first = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(first.state).toBe("up-to-date");
    expect(await runUpdate(depsFor(w, db, port), s.mapping.id)).toBeNull();
    expect(await runUpdate(depsFor(w, db, port), s.mapping.id)).toBeNull();
    expect(await db.upstreamUpdateRun.count({ where: { mappingId: s.mapping.id } })).toBe(1);
    expect(await db.notification.count()).toBe(0);
    // a NEW upstream commit that the fork already has (merged by the person) is a new sha: recorded once more
    const sha = w.commitUpstream({ "z.txt": "z\n" }, "z");
    git(`${w.root}/wf`, "fetch", w.upstream, "main");
    git(`${w.root}/wf`, "merge", "--ff-only", sha);
    git(`${w.root}/wf`, "push", "origin", "main");
    const again = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(again.state).toBe("up-to-date");
    expect(again.upstreamSha).toBe(sha);
    expect(await db.upstreamUpdateRun.count({ where: { mappingId: s.mapping.id } })).toBe(2);
  });

  it("notifies for a notable outcome once, and not for up-to-date or a cancelled run", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitUpstream({ "a.txt": "a\n" }, "a");
    await runUpdate(depsFor(w, db, port), s.mapping.id); // merged-untested: notable
    expect(await db.notification.count()).toBe(1);
    const n = await db.notification.findFirstOrThrow();
    expect(n).toMatchObject({ kind: "upstream-update", userId: s.user.id, repositoryId: s.fork.id, href: `/forks#m-${s.mapping.id}`, readAt: null });
    expect(n.title).toMatch(/ready for review \(not tested\): owner\/proj/);
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { enabled: false } });
    expect(await runUpdate(depsFor(w, db, port), s.mapping.id)).toBeNull();
    expect(await db.notification.count()).toBe(1);
  });

  it("a conflict notifies, and a stored opt-out for the kind is honoured", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    w.commitFork({ "base.txt": "line1\nOURS\nline3\n" }, "ours");
    w.commitUpstream({ "base.txt": "line1\nTHEIRS\nline3\n" }, "theirs");
    await db.notificationPref.create({ data: { userId: s.user.id, prefs: { kinds: { "upstream-update": { inApp: false, desktop: false } } } } });
    expect((await runUpdate(depsFor(w, db, port), s.mapping.id))!.state).toBe("conflict");
    expect(await db.notification.count()).toBe(0);
    await db.notificationPref.deleteMany();
    w.commitUpstream({ "base.txt": "line1\nTHEIRS2\nline3\n" }, "theirs again");
    expect((await runUpdate(depsFor(w, db, port), s.mapping.id))!.state).toBe("conflict");
    const notes = await db.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/merge conflict/);
  });

  it("an unreachable fork is a failed run with a notification, and URL credentials never reach the log or the error", async () => {
    const s = await setupMapping(db, { verifyCommand: null });
    const deps = depsFor(w, db, port, { remoteUrl: () => `https://user:topsecret@127.0.0.1:9/none.git` });
    const run = (await runUpdate(deps, s.mapping.id))!;
    expect(run.state).toBe("failed");
    expect(`${run.error}${run.logTail}`).not.toContain("topsecret");
    expect(await db.notification.count()).toBe(1);
  }, 60_000);

  it("a run records its log on disk under the updater folder and its tail on the row", async () => {
    const s = await setupMapping(db, { verifyCommand: w.script("v", `console.log("VERIFY-OUTPUT-MARK")`) });
    w.commitUpstream({ "a.txt": "a\n" }, "a");
    const run = (await runUpdate(depsFor(w, db, port), s.mapping.id))!;
    expect(run.logTail).toContain("VERIFY-OUTPUT-MARK");
    expect(fs.readFileSync(`${w.home}/updater/${s.mapping.id}/logs/${run.id}.verify.log`, "utf8")).toContain("VERIFY-OUTPUT-MARK");
    expect(fs.existsSync(`${w.home}/updater/${s.mapping.id}/logs/${run.id}.log`)).toBe(true);
  });

  it("nothing runs for a mapping with auto-update off or without a config, and nothing is recorded", async () => {
    const off = await setupMapping(db, { enabled: false });
    w.commitUpstream({ "a.txt": "a\n" }, "a");
    expect(await runUpdate(depsFor(w, db, port), off.mapping.id)).toBeNull();
    const none = await setupMapping(db, null);
    expect(await runUpdate(depsFor(w, db, port), none.mapping.id)).toBeNull();
    expect(await db.upstreamUpdateRun.count()).toBe(0);
    expect(fs.existsSync(`${w.home}/updater`)).toBe(false);
  });

  it("works only inside the updater folder: a hostile mapping id is refused before anything is created", async () => {
    await setupMapping(db, { verifyCommand: null });
    await expect(runUpdate(depsFor(w, db, port), "../../escape")).resolves.toBeNull(); // no such mapping
    expect(() => updaterDir(w.home, "../../escape")).toThrow();
    expect(fs.existsSync(`${w.root}/escape`)).toBe(false);
  });
});
