import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GithubPort } from "@/lib/github/port";
import { runUpdate, type UpdaterDeps } from "@/lib/local/upstream-updater";
import { upsertRepository } from "@/lib/services/repositories";
import { runReleaseCheck } from "@/lib/services/upstream-releases";
import { getUpdateConfig, saveUpdateConfig } from "@/lib/services/upstream-update";
import { ValidationError } from "@/lib/errors";
import { entityDef, parseEntityPath, type Ctx } from "@/lib/sync/entities";
import { testDb } from "./helpers";
import { setupMapping } from "./updater-world";

vi.setConfig({ testTimeout: 30_000 });
const db = testDb();
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

let n = 0;
async function ctxFor(s: Awaited<ReturnType<typeof setupMapping>>): Promise<Ctx> {
  const space = await db.space.create({ data: { remoteId: `pin${n}`, teamRemoteId: "t", kind: "COMMON", name: "team", repoOwner: "acme", repoName: `pin-${n++}` } });
  return { workspaceId: s.workspace.id, localMemberId: s.member.id, space, commonSpaceId: space.id };
}

const repoData = (githubId: bigint, owner: string, name: string) => ({
  githubId: githubId.toString(), fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, description: null, visibility: "PUBLIC", isFork: false,
  parentGithubId: null, parentFullName: null, defaultBranch: "main", archived: false, owner: { githubId: (githubId + 1000n).toString(), login: owner, type: "USER", avatarUrl: null },
});

/** Every way a run could reach git or GitHub throws: a blocked run must not get that far. */
function deadDeps(): UpdaterDeps & { touched: string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mpp-"));
  homes.push(home);
  const touched: string[] = [];
  return {
    db, home, touched,
    port: async () => {
      touched.push("port");
      throw new Error("GitHub was called");
    },
    remoteUrl: (role) => {
      touched.push(role);
      throw new Error("git was called");
    },
  };
}

describe("shared entities cannot take over this person's repositories", () => {
  it("a teammate's repo entity does not rename, re-space or share a local-only repository", async () => {
    const s = await setupMapping(db, null);
    const ctx = await ctxFor(s);
    await entityDef("repo")!.apply(db, ctx, "repo-11", repoData(11n, "evil", "proj"), 1);
    const fork = await db.repository.findUniqueOrThrow({ where: { id: s.fork.id } });
    expect(fork).toMatchObject({ fullName: "owner/proj", name: "proj", spaceId: null, ownerId: s.fork.ownerId });
    expect(await db.repositoryGrant.count({ where: { repositoryId: s.fork.id } })).toBe(0);
    // Nor can a mapping file re-point the local-only mapping.
    const other = await upsertRepository(db, s.workspace.id, { ...repoData(13n, "evil", "other"), githubId: 13n, isFork: false, visibility: "PUBLIC", owner: { githubId: 1013n, login: "evil", type: "USER" } });
    await entityDef("forkmap")!.apply(db, ctx, s.mapping.id, { forkRepoGithubId: "11", upstreamRepoGithubId: "13", forkBranch: "main", upstreamBranch: "main" }, 1);
    expect((await db.forkMapping.findUniqueOrThrow({ where: { id: s.mapping.id } })).upstreamRepoId).toBe(s.upstream.id);
    expect(other.id).toBeTruthy();
  });
});

describe("auto-update runs only on the mapping the person saved", () => {
  it("a remotely changed mapping (branches or upstream repo) stops auto-update until the owner saves again, and runs nothing", async () => {
    const s = await setupMapping(db, null);
    const ctx = await ctxFor(s);
    await db.repository.updateMany({ where: { id: { in: [s.fork.id, s.upstream.id] } }, data: { spaceId: ctx.space.id } }); // the fork is shared
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true });
    await entityDef("forkmap")!.apply(db, ctx, s.mapping.id, { forkRepoGithubId: "11", upstreamRepoGithubId: "12", forkBranch: "main", upstreamBranch: "evil-branch" }, 2);

    const deps = deadDeps();
    expect(await runUpdate(deps, s.mapping.id)).toBeNull();
    expect(deps.touched).toEqual([]);
    const runs = await db.upstreamUpdateRun.findMany({ where: { mappingId: s.mapping.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "failed" });
    expect(runs[0].error).toMatch(/mapping changed since you enabled auto-update: review and save again/);
    const notes = await db.notification.count();
    expect(notes).toBeGreaterThan(0);
    // Asking again with the same reason neither runs, records nor notifies again.
    expect(await runUpdate(deps, s.mapping.id, { manual: true })).toBeNull();
    expect(await db.upstreamUpdateRun.count({ where: { mappingId: s.mapping.id } })).toBe(1);
    expect(await db.notification.count()).toBe(notes);

    // A different upstream repository is caught the same way.
    const third = await upsertRepository(db, s.workspace.id, { ...repoData(14n, "upstream", "third"), githubId: 14n, isFork: false, visibility: "PUBLIC", owner: { githubId: 1012n, login: "upstream", type: "USER" } });
    await db.repository.update({ where: { id: third.id }, data: { spaceId: ctx.space.id } });
    await entityDef("forkmap")!.apply(db, ctx, s.mapping.id, { forkRepoGithubId: "11", upstreamRepoGithubId: "14", forkBranch: "main", upstreamBranch: "main" }, 3);
    expect(await runUpdate(deps, s.mapping.id)).toBeNull();
    expect(deps.touched).toEqual([]);
    expect((await db.upstreamUpdateRun.findFirstOrThrow({ where: { mappingId: s.mapping.id }, orderBy: { startedAt: "desc" } })).error).toMatch(/upstream is now upstream\/third/);

    // Saving again approves what is there now: the run goes ahead (and reaches git, which throws here).
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true });
    const done = await runUpdate(deps, s.mapping.id);
    expect(deps.touched).toContain("fork");
    expect(done?.error).toMatch(/git was called/);
  });

  it("a remotely renamed upstream repository full name stops the run", async () => {
    const s = await setupMapping(db, null);
    const ctx = await ctxFor(s);
    await db.repository.updateMany({ where: { id: { in: [s.fork.id, s.upstream.id] } }, data: { spaceId: ctx.space.id } });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true });
    await entityDef("repo")!.apply(db, ctx, "repo-12", repoData(12n, "evil", "proj"), 2); // same GitHub id, another name
    expect((await db.repository.findUniqueOrThrow({ where: { id: s.upstream.id } })).fullName).toBe("evil/proj");
    const deps = deadDeps();
    expect(await runUpdate(deps, s.mapping.id)).toBeNull();
    expect(deps.touched).toEqual([]);
    expect((await db.upstreamUpdateRun.findFirstOrThrow({ where: { mappingId: s.mapping.id } })).error).toMatch(/mapping changed.*upstream is now evil\/proj/);
    // The release watch refuses the same way, without asking GitHub.
    await db.upstreamUpdateConfig.update({ where: { mappingId: s.mapping.id }, data: { mode: "releases" } });
    const port = { listReleases: vi.fn(async () => { throw new Error("GitHub was called"); }) } as unknown as GithubPort;
    expect((await runReleaseCheck(db, port, s.mapping.id, { manual: true })).result).toBe("skipped");
    expect(port.listReleases).not.toHaveBeenCalled();
  });

  it("two enabled configs on one fork cannot share a sync branch and the default branch names differ", async () => {
    const s = await setupMapping(db, null);
    const up2 = await upsertRepository(db, s.workspace.id, { ...repoData(15n, "other", "proj"), githubId: 15n, isFork: false, visibility: "PUBLIC", owner: { githubId: 1015n, login: "other", type: "USER" } });
    const m2 = await db.forkMapping.create({ data: { forkRepoId: s.fork.id, upstreamRepoId: up2.id, forkBranch: "main", upstreamBranch: "dev" } });
    await saveUpdateConfig(db, s.viewer, s.mapping.id, { enabled: true });
    const first = (await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: s.mapping.id } })).branchName;
    const shown = (await getUpdateConfig(db, s.viewer, m2.id)).branchName;
    expect(shown).not.toBe(first);
    await expect(saveUpdateConfig(db, s.viewer, m2.id, { enabled: true, branchName: first })).rejects.toBeInstanceOf(ValidationError);
    await saveUpdateConfig(db, s.viewer, m2.id, { enabled: true });
    const second = (await db.upstreamUpdateConfig.findUniqueOrThrow({ where: { mappingId: m2.id } })).branchName;
    expect(second).not.toBe(first);
    expect(second).toBe(shown);
  });
});

describe("sync entity hardening", () => {
  it("two devices setting availability for one login converge to one row", async () => {
    const s = await setupMapping(db, null);
    const ctx = await ctxFor(s);
    const def = entityDef("availability")!;
    // Device A wrote its row with a random id (as the settings page does); device B's entity arrives with its own random id.
    await db.reviewerAvailability.create({ data: { id: "rowFromDeviceA", workspaceId: s.workspace.id, login: "alice", note: "A" } });
    expect((await def.list(db, { commonSpaceId: ctx.space.id })).map((l) => l.id)).toEqual(["avail-alice"]);
    await def.apply(db, ctx, "rowFromDeviceB", { login: "alice", from: null, until: null, backup: null, note: "B" }, 1);
    expect((await def.list(db, { commonSpaceId: ctx.space.id })).map((l) => l.id)).toEqual(["avail-alice"]);
    // Each side retiring the other's old id must not delete the person's availability.
    await def.apply(db, ctx, "rowFromDeviceA", null, 2);
    await def.apply(db, ctx, "rowFromDeviceB", null, 2);
    const rows = await db.reviewerAvailability.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("B");
    await def.apply(db, ctx, "avail-alice", { login: "Alice", from: null, until: null, backup: null, note: "both" }, 3);
    expect((await db.reviewerAvailability.findMany()).map((r) => r.note)).toEqual(["both"]);
    await def.apply(db, ctx, "avail-alice", null, 4);
    expect(await db.reviewerAvailability.count()).toBe(0);
  });

  it("malformed remote entities are skipped without throwing and do not block valid ones", async () => {
    const s = await setupMapping(db, null);
    const ctx = await ctxFor(s);
    const bad: [string, string, Record<string, unknown> | null][] = [
      ["repo", "repo-x", null],
      ["repo", "repo-x", repoData(16n, "a", "b")],
      ["repo", "repo-16", { ...repoData(16n, "a", "b"), owner: null }],
      ["card", "c1", { projectId: "p", columnKey: "todo", title: { evil: true }, position: 1 }],
      ["forkmap", "fm1", { forkBranch: "main" }],
      ["waiting", "w1", { reviewerKind: "USER", reviewerRef: "x", reason: "r", status: "PENDING", startedAt: "not a date" }],
      ["project", "bad id!", { name: "n", slug: "s" }],
      ["project", "x".repeat(200), { name: "n", slug: "s" }],
    ];
    for (const [type, id, data] of bad) await expect(entityDef(type)!.apply(db, ctx, id, data as never, 1)).resolves.toBe("invalid");
    expect(await db.repository.count({ where: { githubId: 16n } })).toBe(0);
    await entityDef("project")!.apply(db, ctx, "goodproj", { name: "Good", slug: "good", description: null, automation: "off", repoIds: [] }, 1);
    expect(await db.project.count({ where: { id: "goodproj" } })).toBe(1);
    expect(parseEntityPath(`entities/project/${"x".repeat(129)}.json`)).toBeNull();
  });
});
