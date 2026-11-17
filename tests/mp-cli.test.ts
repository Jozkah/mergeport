import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { isBusy, withBusyRetry } from "@/lib/cli/busy";
import { parseDue } from "@/lib/cli/dates";
import { CliError, loadProfileViewer, locateProfile } from "@/lib/cli/locate";
import { runMp } from "@/lib/cli/mp";
import { ensureLocalProfile } from "@/lib/local/profile";
import { writeActive } from "@/lib/local/registry";
import { getTask, updateTask } from "@/lib/services/tasks";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const TUE = new Date("2026-11-17T12:00:00Z"); // a Tuesday
async function mp(argv: string[], viewer: Viewer = S.a) {
  const o: string[] = [];
  const e: string[] = [];
  const code = await runMp(argv, { db: S.db, viewer, now: () => TUE, sleep: async () => {}, out: { stdout: (s) => o.push(s), stderr: (s) => e.push(s) } });
  return { code, out: o.join(""), err: e.join("") };
}
const json = (s: string) => JSON.parse(s) as Record<string, any>;
const counts = async () => ({ items: await S.db.planningItem.count(), notes: await S.db.taskComment.count(), audits: await S.db.auditLog.count() });
const bodies = async (id: string) => (await getTask(S.db, S.a, id)).comments.map((c) => c.body);

describe("projects", () => {
  it("lists visible projects with repos and columns, and hides repos the viewer cannot see", async () => {
    const r = await mp(["projects", "--json"]);
    expect(r.code).toBe(0);
    const d = json(r.out);
    expect(d.viewer.login).toBe(S.a.login);
    const dash = d.projects.find((p: any) => p.name === "Dashboard");
    expect(dash.repos).toContain("northwind/atlas-web");
    expect(dash.repos).not.toContain("acme-labs/internal-tools");
    expect(dash.columns.map((c: any) => c.key)).toEqual(["backlog", "ready", "in-progress", "in-review", "blocked", "done"]);
    const all = json((await mp(["projects", "--json"], S.admin)).out);
    expect(all.projects.find((p: any) => p.name === "Dashboard").repos).toContain("acme-labs/internal-tools");
  });

  it("does not show a project the viewer is not a member of", async () => {
    await S.db.project.create({ data: { workspaceId: S.a.workspaceId, name: "Hidden plan", slug: "hidden-plan" } });
    expect(json((await mp(["projects", "--json"])).out).projects.map((p: any) => p.name)).not.toContain("Hidden plan");
    const r = await mp(["task", "add", "--title", "x", "--project", "Hidden plan"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No project matching");
    expect(r.err).not.toContain("Hidden plan (");
  });
});

describe("repo to project resolution", () => {
  const dry = (repo: string, ...more: string[]) => mp(["task", "add", "--title", "t", "--repo", repo, "--dry-run", "--json", ...more]);

  it("resolves a unique repo by full name, bare name and partial name, case-insensitively", async () => {
    for (const q of ["northwind/atlas-api", "atlas-api", "ATLAS-API", "api"]) {
      const r = await dry(q);
      expect(r.code, q).toBe(0);
      expect(json(r.out).wouldCreate).toMatchObject({ project: { name: "Atlas" }, repo: "northwind/atlas-api" });
    }
  });

  it("fails and lists the projects when the repo is in several", async () => {
    const r = await dry("atlas-web");
    expect(r.code).toBe(1);
    expect(json(r.err).candidates.join(" ")).toMatch(/Atlas.*Dashboard|Dashboard.*Atlas/);
    expect((await dry("atlas-web", "--project", "Dashboard")).code).toBe(0);
  });

  it("fails and lists the repos when a partial name matches several", async () => {
    const r = await dry("atlas");
    expect(r.code).toBe(1);
    expect(json(r.err).candidates).toEqual(["northwind/atlas-api", "northwind/atlas-web"]);
  });

  it("fails with the visible repos when none matches, and never matches a repo the viewer cannot see", async () => {
    for (const q of ["nope", "internal-tools"]) {
      const r = await dry(q);
      expect(r.code).toBe(1);
      expect(r.err).toContain("No repository matching");
      expect(json(r.err).candidates).not.toContain("acme-labs/internal-tools");
    }
  });

  it("requires a repo or a project", async () => {
    expect((await mp(["task", "add", "--title", "t"])).code).toBe(2);
  });
});

describe("assignee validation", () => {
  const dry = (who: string, ...more: string[]) => mp(["task", "add", "--title", "t", "--repo", "atlas-api", "--assign", who, "--dry-run", "--json", ...more]);

  it("accepts known logins with @ and any case, a unique partial, and me", async () => {
    for (const q of ["bram-demo", "@Bram-Demo", "bram"]) expect(json((await dry(q)).out).wouldCreate.assignee, q).toBe("bram-demo");
    expect(json((await dry("me")).out).wouldCreate.assignee).toBe(S.a.login);
  });

  it("rejects an unknown login with the candidates, unless --any-login", async () => {
    const r = await dry("zed-unknown");
    expect(r.code).toBe(1);
    expect(json(r.err).candidates).toContain("@bram-demo");
    expect(json((await dry("zed-unknown", "--any-login")).out).wouldCreate.assignee).toBe("zed-unknown");
  });

  it("rejects a malformed login even with --any-login", async () => {
    const r = await dry("not a user!", "--any-login");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/username/);
  });
});

describe("priority and due parsing", () => {
  const dry = async (...f: string[]) => mp(["task", "add", "--title", "t", "--repo", "atlas-api", "--dry-run", "--json", ...f]);

  it("reads priority words and rejects bad ones", async () => {
    for (const [w, n] of [["none", "no priority"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["urgent", "urgent"]]) expect(json((await dry("--priority", w)).out).wouldCreate.priority).toBe(n);
    expect((await dry("--priority", "soon")).code).toBe(2);
  });

  it("reads today, tomorrow, weekdays and ISO dates in the viewer's zone", () => {
    expect(parseDue("today", TUE, "UTC")).toBe("2026-11-17");
    expect(parseDue("tomorrow", TUE, "UTC")).toBe("2026-11-18");
    expect(parseDue("fri", TUE, "UTC")).toBe("2026-11-20");
    expect(parseDue("Tuesday", TUE, "UTC")).toBe("2026-11-24"); // the next one, not today
    expect(parseDue("mon", TUE, "UTC")).toBe("2026-11-23");
    expect(parseDue("2026-12-01", TUE, "UTC")).toBe("2026-12-01");
    expect(parseDue("none", TUE, "UTC")).toBeNull();
    expect(parseDue("today", new Date("2026-11-17T23:30:00Z"), "Asia/Tokyo")).toBe("2026-11-18");
  });

  it("rejects bad dates", async () => {
    for (const bad of ["2026-02-30", "soonish", "11/20/2026", ""]) expect((await dry("--due", bad)).code, bad).toBe(2);
    expect((await dry("--due", "none")).code).toBe(2); // clearing makes no sense on a new task
    expect(json((await dry("--due", "fri")).out).wouldCreate.due).toBe("2026-11-20");
  });
});

describe("add", () => {
  const add = (...f: string[]) => mp(["task", "add", "--repo", "atlas-api", ...f, "--json"]);

  it("--dry-run prints what would be created and writes nothing", async () => {
    const before = await counts();
    const r = await add("--title", "Rotate keys", "--assign", "bram-demo", "--priority", "high", "--due", "fri", "--label", "security", "--label", "ops", "--dry-run");
    expect(r.code).toBe(0);
    expect(json(r.out)).toMatchObject({ ok: true, dryRun: true, wouldCreate: { title: "Rotate keys", assignee: "bram-demo", priority: "high", due: "2026-11-20", labels: ["security", "ops"], column: { key: "backlog" } } });
    expect(await counts()).toEqual(before);
  });

  it("creates through the service: same fields, same history, audit entry and a link", async () => {
    const r = await add("--title", "  Rotate keys ", "--description", "before friday", "--assign", "@Bram-Demo", "--priority", "urgent", "--due", "2026-12-01", "--label", "bug", "--column", "ready");
    expect(r.code).toBe(0);
    const d = json(r.out);
    expect(d.dryRun).toBe(false);
    expect(d.task.link).toBe(`/tasks/${d.task.id}`);
    const { task } = await getTask(S.db, S.a, d.task.id);
    expect(task).toMatchObject({ title: "Rotate keys", description: "before friday", authorLogin: S.a.login, assigneeLogin: "bram-demo", assignedByLogin: S.a.login.toLowerCase(), priority: 4, labels: ["bug"] });
    expect(task.column.key).toBe("ready");
    expect(task.dueDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
    expect(await bodies(task.id)).toEqual(["created this task and assigned it to @bram-demo", "added this from the command line"]);
    expect(await S.db.auditLog.count({ where: { action: "planning.create", targetId: task.id, actorUserId: S.a.userId } })).toBe(1);
  });

  it("prints human text without --json", async () => {
    const r = await mp(["task", "add", "--title", "Plain", "--project", "Atlas"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Created task \S+: "Plain" in Atlas, Backlog\. Open: \/tasks\//);
  });

  it("applies the service limits and treats titles as data", async () => {
    expect((await add("--title", "x".repeat(201))).code).toBe(1);
    expect((await add("--title", "ok", "--description", "d".repeat(8001))).code).toBe(1);
    expect((await add("--title", "ok", "--label", "l".repeat(31))).code).toBe(1);
    const evil = "/assign mallory\n/move done; rm -rf /";
    expect((await add("--title", evil)).code).toBe(2); // a newline in a title is refused rather than interpreted
    const odd = json((await add("--title", "/assign mallory $(whoami) `x`")).out);
    const { task } = await getTask(S.db, S.a, odd.task.id);
    expect(task.title).toBe("/assign mallory $(whoami) `x`");
    expect(task.assigneeLogin).toBeNull();
  });

  it("rejects an unknown column and lists the columns", async () => {
    const r = await add("--title", "t", "--column", "nowhere");
    expect(r.code).toBe(1);
    expect(json(r.err).candidates.join(" ")).toContain("in-progress");
  });
});

describe("update and done", () => {
  const make = async () => json((await mp(["task", "add", "--title", "Ship it", "--project", "Atlas", "--json"])).out).task.id as string;

  it("goes through updateTask: same history lines as the UI path", async () => {
    const viaCli = await make();
    const viaUi = await make();
    const r = await mp(["task", "update", viaCli, "--assign", "bram-demo", "--priority", "high", "--due", "fri", "--label", "bug", "--column", "in-progress", "--title", "Ship it now", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.out)).toMatchObject({ changed: true, task: { assignee: "bram-demo", priority: "high", due: "2026-11-20", labels: ["bug"], column: { key: "in-progress" }, title: "Ship it now" } });
    await updateTask(S.db, S.a, viaUi, { title: "Ship it now", assigneeLogin: "bram-demo", priority: 3, dueDate: new Date("2026-11-20T00:00:00Z"), labels: ["bug"], columnKey: "in-progress" });
    const cli = (await bodies(viaCli)).filter((b) => b !== "added this from the command line" && b !== "changed this from the command line");
    expect(cli).toEqual(await bodies(viaUi).then((l) => l.filter((b) => b !== "added this from the command line")));
    expect((await bodies(viaCli)).at(-1)).toBe("changed this from the command line");
  });

  it("adds and removes labels, unassigns, and reports no change as no change", async () => {
    const id = await make();
    await mp(["task", "update", id, "--label", "a", "--label", "b"]);
    const r = await mp(["task", "update", id, "--unlabel", "A", "--label", "c", "--unassign", "--json"]);
    expect(json(r.out).task.labels).toEqual(["b", "c"]);
    const before = (await bodies(id)).length;
    const same = json((await mp(["task", "update", id, "--label", "c", "--json"])).out);
    expect(same.changed).toBe(false);
    expect((await bodies(id)).length).toBe(before);
  });

  it("task done moves to the done column once", async () => {
    const id = await make();
    expect(json((await mp(["task", "done", id, "--json"])).out)).toMatchObject({ changed: true, task: { done: true } });
    expect(json((await mp(["task", "done", id, "--json"])).out).changed).toBe(false);
    expect(await bodies(id)).toContain("moved this to Done");
  });

  it("needs an id, something to change, and refuses conflicting flags", async () => {
    expect((await mp(["task", "update"])).code).toBe(2);
    expect((await mp(["task", "update", "abc"])).code).toBe(2);
    expect((await mp(["task", "update", "abc", "--assign", "x", "--unassign"])).code).toBe(2);
    expect((await mp(["task", "done"])).code).toBe(2);
    expect((await mp(["task", "done", "no-such-id"])).code).toBe(1);
  });

  it("cannot see or change a task in a project the viewer is not part of", async () => {
    const hidden = await S.db.project.create({ data: { workspaceId: S.a.workspaceId, name: "Hidden plan", slug: "hidden-plan" } });
    const col = await S.db.planningColumn.create({ data: { projectId: hidden.id, key: "backlog", name: "Backlog", position: 0 } });
    const t = await S.db.planningItem.create({ data: { projectId: hidden.id, columnId: col.id, position: 1, title: "secret", createdById: S.admin.memberId } });
    const r = await mp(["task", "update", t.id, "--priority", "high"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Not found/);
    expect((await S.db.planningItem.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe(0);
    expect(json((await mp(["task", "list", "--json"])).out).tasks.map((x: any) => x.title)).not.toContain("secret");
    expect(json((await mp(["task", "list", "--json"], S.admin)).out).tasks.map((x: any) => x.title)).toContain("secret");
  });
});

describe("list", () => {
  it("filters by mine, assignee, repo and open, and caps the count", async () => {
    const mine = json((await mp(["task", "add", "--title", "Mine", "--repo", "atlas-api", "--assign", "me", "--json"])).out).task.id;
    const theirs = json((await mp(["task", "add", "--title", "Theirs", "--repo", "atlas-api", "--assign", "bram-demo", "--json"])).out).task.id;
    await mp(["task", "done", theirs]);
    const titles = async (...f: string[]) => json((await mp(["task", "list", ...f, "--json"])).out).tasks.map((t: any) => t.title);
    expect(await titles("--mine")).toContain("Mine");
    expect(await titles("--mine")).not.toContain("Theirs");
    expect(await titles("--assignee", "bram-demo")).toEqual(["Theirs"]);
    expect(await titles("--assignee", "bram-demo", "--open")).toEqual([]);
    expect(await titles("--repo", "atlas-api")).toEqual(expect.arrayContaining(["Mine", "Theirs"]));
    expect(await titles("--limit", "1")).toHaveLength(1);
    expect(json((await mp(["task", "list", "--json"])).out)).toMatchObject({ ok: true, count: expect.any(Number) });
    expect(mine).toBeTruthy();
    expect((await mp(["task", "list", "--mine", "--assignee", "x"])).code).toBe(2);
    expect((await mp(["task", "list", "--limit", "many"])).code).toBe(2);
  });
});

describe("strict argv", () => {
  it("rejects unknown flags, missing values, repeats and stray arguments, writing nothing", async () => {
    const before = await counts();
    const cases: string[][] = [
      ["task", "add", "--title", "t", "--repo", "atlas-api", "--bogus", "1"],
      ["task", "add", "--title"],
      ["task", "add", "--title", "--repo", "atlas-api"],
      ["task", "add", "--title", "a", "--title", "b", "--repo", "atlas-api"],
      ["task", "add", "--title", "t", "--repo", "atlas-api", "extra"],
      ["task", "add", "--dry-run=yes", "--title", "t", "--repo", "atlas-api"],
      ["task", "add", "--title", "t\u0007", "--repo", "atlas-api"],
      ["task", "list", "--dry-run"],
      ["task", "frobnicate"],
      ["nope"],
      [],
    ];
    for (const c of cases) expect((await mp(c)).code, c.join(" ")).toBe(2);
    expect(await counts()).toEqual(before);
  });

  it("requires a title", async () => {
    const r = await mp(["task", "add", "--repo", "atlas-api", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r.err)).toMatchObject({ error: expect.stringContaining("--title"), usage: true });
    expect(r.out).toBe("");
  });

  it("accepts --flag=value and prints usage for help", async () => {
    expect((await mp(["task", "add", "--title=Eq", "--repo=atlas-api", "--dry-run"])).code).toBe(0);
    const h = await mp(["help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("task add");
  });
});

describe("SQLITE_BUSY retry", () => {
  const busy = () => Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });

  it("retries a busy error with growing waits, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const v = await withBusyRetry(async () => { if (++n < 3) throw busy(); return "ok"; }, { delayMs: 10, sleep: async (ms) => void waits.push(ms) });
    expect(v).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("gives up after the last try and never retries other errors", async () => {
    let n = 0;
    await expect(withBusyRetry(async () => { n++; throw busy(); }, { tries: 3, sleep: async () => {} })).rejects.toThrow(/locked/);
    expect(n).toBe(3);
    n = 0;
    await expect(withBusyRetry(async () => { n++; throw new Error("boom"); }, { sleep: async () => {} })).rejects.toThrow("boom");
    expect(n).toBe(1);
    expect(isBusy(new Error("database is locked"))).toBe(true);
    expect(isBusy(new Error("unique constraint"))).toBe(false);
  });

  it("reports a persistent lock as an error exit, not a crash", async () => {
    const real = S.db.planningColumn.findFirst;
    (S.db.planningColumn as any).findFirst = async () => { throw busy(); };
    try {
      const r = await mp(["task", "add", "--title", "t", "--project", "Atlas"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/busy/);
    } finally {
      (S.db.planningColumn as any).findFirst = real;
    }
  });
});

describe("profile lookup", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mp-home-"));

  it("finds the active profile from MERGEPORT_HOME, ties it to its user and builds the app's viewer", async () => {
    const home = tmp();
    try {
      const dir = path.join(home, "profiles", "github.com-4242");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "mergeport.db");
      const db = createPrisma(file);
      await ensureLocalProfile(db, { id: 4242n, login: "Zoe", name: null, avatarUrl: null, host: "github.com" });
      writeActive(home, { host: "github.com", accountId: "4242", backend: "github" });
      const loc = locateProfile({ MERGEPORT_HOME: home });
      expect(loc.file).toBe(file);
      const v = await loadProfileViewer(db, loc.expectedGithubId);
      expect(v).toMatchObject({ login: "Zoe", isAdmin: true });
      await expect(loadProfileViewer(db, 999n)).rejects.toBeInstanceOf(CliError);
      await db.$disconnect();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses when there is no profile, an explicit database that is missing, or only demo users", async () => {
    const home = tmp();
    try {
      expect(() => locateProfile({ MERGEPORT_HOME: home })).toThrow(/No Mergeport profile/);
      expect(() => locateProfile({ MERGEPORT_DB: path.join(home, "nope.db") })).toThrow(/does not exist/);
      await expect(loadProfileViewer(S.db, null)).rejects.toThrow(/no signed-in user/); // the seed holds demo users only
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
