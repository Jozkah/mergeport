import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, type Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { ensureLocalProfile } from "@/lib/local/profile";
import { BACKUP_VERSION, exportBackup, parseBackup, previewRestore, restoreBackup } from "@/lib/services/backup";
import { upsertRepository } from "@/lib/services/repositories";
import { createTask } from "@/lib/services/tasks";
import { setPrefs } from "@/lib/services/notification-prefs";
import { saveView } from "@/lib/services/views";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
const files: string[] = [];
let n = 0;
async function target(withRepos: boolean): Promise<{ db: Db; v: Viewer }> {
  const file = path.resolve(".data", `restore-${process.pid}-${n++}.db`);
  files.push(file);
  const db = createPrisma(file);
  const p = await ensureLocalProfile(db, { id: 9001n, login: "restorer", name: "Restorer", avatarUrl: null, host: "github.com" });
  if (withRepos) {
    for (const r of await S.db.repository.findMany({ where: { isDemo: false }, include: { owner: true } })) {
      await upsertRepository(db, p.workspace.id, { githubId: r.githubId, fullName: r.fullName, name: r.name, htmlUrl: r.htmlUrl, visibility: "PRIVATE", isFork: r.isFork, defaultBranch: r.defaultBranch, archived: false, owner: { githubId: r.owner.githubId, login: r.owner.login, type: "ORGANIZATION" } });
    }
  }
  return { db, v: (await loadViewer(db, p.user.id))! };
}
afterAll(() => {
  for (const f of files) for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
});
beforeEach(async () => {
  S = await freshSeed();
  // The demo seed's repositories are flagged demo; treat them as real for the round trip.
  await S.db.repository.updateMany({ data: { isDemo: false } });
});

describe("backup and restore", () => {
  it("exports Mergeport-owned state only: no credentials, no local paths, nothing GitHub owns", async () => {
    const { db, admin, a } = S;
    const dev = await db.device.create({ data: { userId: admin.userId, name: "My PC" } });
    const repo = await db.repository.findFirstOrThrow();
    await db.deviceRepoMapping.create({ data: { deviceId: dev.id, repositoryId: repo.id, rootPath: "C:/Users/secret-person/code/app" } });
    await db.worktreeSnapshot.create({ data: { deviceId: dev.id, repositoryId: repo.id, capturedAt: new Date(), data: { worktrees: [{ path: "C:/Users/secret-person/code/app" }] } } });
    await db.session.create({ data: { tokenHash: "hash-should-never-leave", csrfToken: "csrf-should-never-leave", userId: admin.userId, expiresAt: new Date(Date.now() + 1e9) } });
    await saveView(db, admin, { scope: "tasks", name: "Mine", query: "scope=mine" });
    await saveView(db, a, { scope: "tasks", name: "Alice only", query: "scope=all" });
    const text = await exportBackup(db, admin);
    for (const forbidden of ["secret-person", "should-never-leave", "rootPath", "tokenHash", "csrfToken", "Alice only"]) expect(text).not.toContain(forbidden);
    const b = parseBackup(text);
    expect(b).toMatchObject({ format: "mergeport-backup", version: BACKUP_VERSION });
    expect(Object.keys(b.tables)).not.toEqual(expect.arrayContaining(["WorkItem", "Session", "DeviceRepoMapping", "WorktreeSnapshot", "GitCache"]));
    expect(b.tables.Project.length).toBe(await db.project.count());
    expect(b.tables.SavedFilter.map((r) => r.name)).toEqual(["Mine"]); // only the exporter's own personal state
    await expect(exportBackup(db, a)).rejects.toThrow(/administrator/);
  });

  it("restores onto another computer: remaps owners, previews first, is additive and idempotent", async () => {
    const { db, admin, ids } = S;
    const t0 = await createTask(db, admin, { projectId: ids.projects.atlas.id, title: "Backed-up task", labels: ["x"] });
    await setPrefs(db, admin.userId, { kinds: { "review-requested": { inApp: false, desktop: false } } });
    const text = await exportBackup(db, admin);
    const { db: tdb, v } = await target(true);
    const preview = await previewRestore(tdb, v, parseBackup(text));
    expect(await tdb.project.count()).toBe(0); // previewing wrote nothing
    expect(preview.tables.find((t) => t.table === "Project")).toMatchObject({ create: 2, update: 0, same: 0 });
    expect(preview.notes[0]).toMatch(/never deletes/);

    await expect(restoreBackup(tdb, v, parseBackup(text), { confirmed: false })).rejects.toThrow(/Confirm/);
    const done = await restoreBackup(tdb, v, parseBackup(text), { confirmed: true });
    expect(done.tables.find((t) => t.table === "PlanningItem")!.create).toBeGreaterThan(0);
    expect(await tdb.project.count()).toBe(2);
    const card = await tdb.planningItem.findUniqueOrThrow({ where: { id: t0.id } });
    expect(card).toMatchObject({ title: "Backed-up task", createdById: v.memberId, labels: ["x"] }); // the card now belongs to this computer's person
    expect((await tdb.project.findFirstOrThrow()).workspaceId).toBe(v.workspaceId);
    expect(JSON.stringify((await tdb.notificationPref.findUniqueOrThrow({ where: { userId: v.userId } })).prefs)).toContain("review-requested");
    // Running it again changes nothing.
    const again = await restoreBackup(tdb, v, parseBackup(text), { confirmed: true });
    expect(again.tables.every((t) => t.create === 0 && t.update === 0)).toBe(true);
    // A change made since the backup shows up as an update in the preview.
    await tdb.planningItem.update({ where: { id: t0.id }, data: { title: "Edited later" } });
    expect((await previewRestore(tdb, v, parseBackup(text))).tables.find((t) => t.table === "PlanningItem")!.update).toBe(1);
    await tdb.$disconnect();
  });

  it("skips what points at an untracked repository, and says so, instead of guessing", async () => {
    const { db, admin } = S;
    const text = await exportBackup(db, admin);
    const { db: tdb, v } = await target(false); // no repositories tracked there
    const p = await previewRestore(tdb, v, parseBackup(text));
    expect(p.skipped.some((s) => s.table === "ProjectRepository" && /not tracked on this computer/.test(s.why))).toBe(true);
    expect(p.skipped.some((s) => s.table === "ForkMapping")).toBe(true);
    await tdb.$disconnect();
  });

  it("restores unsent edits only into a team space that exists there, and keeps them pending", async () => {
    const { db, admin } = S;
    const space = await db.space.create({ data: { remoteId: "space-1", teamRemoteId: "t1", kind: "COMMON", name: "x", repoOwner: "o", repoName: "r" } });
    await db.outboxOp.create({ data: { id: "op-1", spaceId: space.id, entityType: "card", entityId: "c1", kind: "UPSERT", data: { a: 1 }, status: "FAILED" } });
    const text = await exportBackup(db, admin);
    const b = parseBackup(text);
    expect(b.source.unsentEdits).toBe(1);
    const { db: tdb, v } = await target(true);
    expect((await restoreBackup(tdb, v, b, { confirmed: true })).outbox).toEqual({ restorable: 0, skipped: 1 });
    await tdb.space.create({ data: { remoteId: "space-1", teamRemoteId: "t1", kind: "COMMON", name: "x", repoOwner: "o", repoName: "r" } });
    expect((await restoreBackup(tdb, v, b, { confirmed: true })).outbox).toEqual({ restorable: 1, skipped: 0 });
    expect((await tdb.outboxOp.findUniqueOrThrow({ where: { id: "op-1" } })).status).toBe("PENDING");
    await tdb.$disconnect();
  });

  it("refuses damaged files, newer formats and newer databases, and non-administrators", async () => {
    const { db, admin, a } = S;
    const text = await exportBackup(db, admin);
    expect(() => parseBackup("not json")).toThrow(/not valid JSON/);
    expect(() => parseBackup(JSON.stringify({ hello: 1 }))).toThrow(/not a Mergeport backup/);
    expect(() => parseBackup(text.replace(`"version":${BACKUP_VERSION}`, `"version":${BACKUP_VERSION + 1}`))).toThrow(/newer Mergeport/);
    expect(() => parseBackup(text.replace(/"migration":"[^"]+"/, '"migration":"29991231235959_future"'))).toThrow(/newer version of the database/);
    const { db: tdb, v } = await target(true);
    await expect(previewRestore(tdb, { ...v, isAdmin: false }, parseBackup(text))).rejects.toThrow(/administrator/);
    void a;
    await tdb.$disconnect();
  });

  it("is atomic: a bad row leaves nothing half-restored", async () => {
    const { db, admin } = S;
    const b = parseBackup(await exportBackup(db, admin));
    b.tables.PlanningItem = [{ ...b.tables.PlanningItem[0], id: "broken-card", columnId: "no-such-column" }, ...b.tables.PlanningItem];
    const { db: tdb, v } = await target(true);
    await expect(restoreBackup(tdb, v, b, { confirmed: true })).rejects.toThrow();
    expect(await tdb.project.count()).toBe(0);
    expect(await tdb.planningItem.count()).toBe(0);
    await tdb.$disconnect();
  });
});
