import { beforeEach, describe, expect, it } from "vitest";
import { applyAutoSetup, planAutoSetup } from "@/lib/services/auto-setup";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { truncateAll } from "@/lib/demo/seed";
import { testDb } from "./helpers";

const db = testDb();
let ws: string;
const viewer = () => ({ workspaceId: ws, login: "me", isAdmin: true, memberId: "m" }) as never;

const meta = (id: bigint, owner: string, name: string, type: "USER" | "ORGANIZATION", extra: Partial<RepoMeta> = {}): RepoMeta => ({
  githubId: id, fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, visibility: "PRIVATE", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: id + 1000n, login: owner, type }, ...extra,
});

beforeEach(async () => {
  await truncateAll(db);
  ws = (await db.workspace.create({ data: { name: "w" } })).id;
});

describe("set up automatically", () => {
  it("proposes projects by owner, fork mappings from GitHub's parent, and waiting rules for other people's repositories", async () => {
    await upsertRepository(db, ws, meta(1n, "me", "a", "USER"));
    await upsertRepository(db, ws, meta(2n, "me", "b", "USER"));
    await upsertRepository(db, ws, meta(3n, "maintainer", "tool", "USER"));
    await upsertRepository(db, ws, meta(4n, "acme", "x", "ORGANIZATION"));
    await upsertRepository(db, ws, meta(5n, "acme", "y", "ORGANIZATION"));
    await upsertRepository(db, ws, meta(6n, "me", "tool-fork", "USER", { isFork: true, parentGithubId: 3n, parentFullName: "maintainer/tool" }));
    const plan = await planAutoSetup(db, viewer());
    const ids = plan.steps.map((s) => s.id).sort();
    expect(ids).toContain("project:me");
    expect(ids).toContain("project:acme");
    expect(ids).toContain("waiting:maintainer");
    expect(ids.some((i) => i.startsWith("fork:"))).toBe(true);
    expect(ids).not.toContain("waiting:acme"); // an organization is not a person who merges
    expect(ids).not.toContain("waiting:me");
    expect(plan.steps.every((s) => s.basis.length > 10)).toBe(true);
    expect(plan.nothingToConfigure.length).toBeGreaterThan(0);
  });

  it("applies only what is selected, writes nothing outside the local database, and a second run proposes nothing", async () => {
    await upsertRepository(db, ws, meta(1n, "me", "a", "USER"));
    await upsertRepository(db, ws, meta(2n, "me", "b", "USER"));
    await upsertRepository(db, ws, meta(3n, "maintainer", "tool", "USER"));
    await applyAutoSetup(db, viewer(), ["waiting:maintainer"]);
    expect(await db.project.count()).toBe(0);
    const rule = await db.waitingRule.findFirstOrThrow();
    expect(rule.ownerLogin).toBe("maintainer");
    expect(rule.waitingOn).toEqual([{ kind: "USER", ref: "maintainer" }]);
    await applyAutoSetup(db, viewer(), ["project:me"]);
    expect(await db.projectRepository.count()).toBe(2);
    const again = await planAutoSetup(db, viewer());
    expect(again.steps.filter((s) => s.kind === "project" || s.kind === "waiting-rule")).toEqual([]);
  });

  it("reports an untracked fork parent instead of guessing", async () => {
    await upsertRepository(db, ws, meta(6n, "me", "tool-fork", "USER", { isFork: true, parentGithubId: 99n, parentFullName: "someone/tool" }));
    const plan = await planAutoSetup(db, viewer());
    expect(plan.steps.some((s) => s.kind === "fork")).toBe(false);
    expect(plan.skipped.join(" ")).toMatch(/someone\/tool/);
  });

  it("puts open work on the board in the right existing columns", async () => {
    await upsertRepository(db, ws, meta(1n, "me", "a", "USER"));
    await upsertRepository(db, ws, meta(2n, "me", "b", "USER"));
    await applyAutoSetup(db, viewer(), ["project:me"]);
    const project = await db.project.findFirstOrThrow();
    const repo = await db.repository.findFirstOrThrow({ where: { fullName: "me/a" } });
    const mk = (number: number, o: Record<string, unknown>) => db.workItem.create({ data: { repositoryId: repo.id, githubId: BigInt(900 + number), number, title: `t${number}`, htmlUrl: "https://x", createdAtGh: new Date(), updatedAtGh: new Date(), state: "OPEN", ...o } as never });
    await mk(1, { type: "ISSUE" });
    await mk(2, { type: "PULL_REQUEST" });
    await mk(3, { type: "PULL_REQUEST", draft: true });
    await mk(4, { type: "PULL_REQUEST", checksState: "FAILURE" });
    const member = await db.member.create({ data: { workspaceId: ws, userId: (await db.user.create({ data: { githubId: 5n, login: "me" } })).id, role: "ADMIN" } as never });
    const v = { workspaceId: ws, login: "me", isAdmin: true, memberId: member.id } as never;
    await applyAutoSetup(db, v, [`planning:${project.id}`]);
    const cols = await db.planningItem.findMany({ where: { projectId: project.id }, include: { column: true, workItem: true } });
    expect(Object.fromEntries(cols.map((c) => [c.workItem!.number, c.column.key]))).toEqual({ 1: "backlog", 2: "in-review", 3: "in-progress", 4: "blocked" });
  });
});
