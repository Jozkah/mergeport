import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";
import { argsAt } from "./tenancy-scan";
import type { Db } from "@/lib/db";
import { claimAppState } from "@/lib/github/app-state";
import { isBoundInstallation } from "@/lib/github/bound-installation";
import { loadBoundInstallation, setRepositoryInstallation, unbindInstallation } from "@/lib/github/binding";

let db: Db;
const owner = { githubId: 9001n };

async function workspace(name: string) {
  return db.workspace.create({ data: { name } });
}
async function installation(id: bigint, o: { suspended?: boolean; deleted?: boolean } = {}) {
  return db.githubInstallation.create({
    data: { installationId: id, accountGithubId: 5n, accountLogin: "acme", accountType: "ORGANIZATION", suspendedAt: o.suspended ? new Date() : null, deletedAt: o.deleted ? new Date() : null },
  });
}
const bind = (workspaceId: string, installationId: bigint) =>
  db.workspaceInstallation.create({ data: { workspaceId, installationId, verifiedAt: new Date(), verifiedGithubUserId: 77n, proofMethod: "user-installations" } });
async function repo(workspaceId: string, githubId: bigint) {
  const o = await db.githubOwner.upsert({ where: { githubId: owner.githubId }, create: { githubId: owner.githubId, login: "acme", type: "ORGANIZATION" }, update: {} });
  return db.repository.create({ data: { workspaceId, githubId, ownerId: o.id, name: `r${githubId}`, fullName: `acme/r${githubId}`, htmlUrl: "https://github.com/acme/r" } });
}

beforeAll(() => {
  db = createTestPrisma("github-app-bindings");
});
afterAll(async () => {
  await db.$disconnect();
});

describe("WorkspaceInstallation proof and BoundInstallation", () => {
  it("a row cannot exist without proof (NOT NULL verifiedAt, verifiedGithubUserId, proofMethod)", async () => {
    const w = await workspace("proof");
    await installation(1001n);
    await expect(db.workspaceInstallation.create({ data: { workspaceId: w.id, installationId: 1001n } as never })).rejects.toThrow();
  });

  it("loadBoundInstallation returns a bound value only for a proved, usable binding of THIS workspace", async () => {
    const a = await workspace("bound-a");
    const b = await workspace("bound-b");
    await installation(1002n);
    await bind(a.id, 1002n);
    const ok = await loadBoundInstallation(db, a.id, 1002n);
    expect(ok).toMatchObject({ installationId: 1002n, workspaceId: a.id });
    expect(isBoundInstallation(ok)).toBe(true);
    expect(await loadBoundInstallation(db, b.id, 1002n)).toBeNull(); // another workspace has no binding
    expect(await loadBoundInstallation(db, a.id, 424242n)).toBeNull(); // unknown installation
  });

  it("a suspended or deleted installation yields no bound value", async () => {
    const w = await workspace("bound-state");
    await installation(1003n, { suspended: true });
    await installation(1004n, { deleted: true });
    await bind(w.id, 1003n);
    await bind(w.id, 1004n);
    expect(await loadBoundInstallation(db, w.id, 1003n)).toBeNull();
    expect(await loadBoundInstallation(db, w.id, 1004n)).toBeNull();
  });

  it("a hand-made object is not a bound installation", () => {
    expect(isBoundInstallation({ installationId: 1n, workspaceId: "w" })).toBe(false);
    expect(isBoundInstallation(null)).toBe(false);
  });
});

describe("Repository.installationId is tied to the workspace's bindings", () => {
  it("accepts null, a bound installation, and refuses an installation the workspace has not bound", async () => {
    const a = await workspace("fk-a");
    const b = await workspace("fk-b");
    await installation(1010n);
    await bind(a.id, 1010n);
    const ra = await repo(a.id, 1n);
    expect(ra.installationId).toBeNull();
    expect(await setRepositoryInstallation(db, a.id, ra.id, 1010n)).toBe(true);
    // The service refuses an unbound installation...
    const rb = await repo(b.id, 2n);
    await expect(setRepositoryInstallation(db, b.id, rb.id, 1010n)).rejects.toThrow(/no binding/);
    // ...and so does the database, even for a direct write.
    await expect(db.repository.update({ where: { id: rb.id }, data: { installationId: 1010n } })).rejects.toThrow();
    await expect(db.repository.create({ data: { workspaceId: b.id, githubId: 3n, ownerId: ra.ownerId, name: "x", fullName: "acme/x", htmlUrl: "u", installationId: 1010n } })).rejects.toThrow();
  });

  it("the binding cannot be deleted while a repository uses it; unbindInstallation detaches first", async () => {
    const w = await workspace("fk-unbind");
    await installation(1011n);
    await bind(w.id, 1011n);
    const r = await repo(w.id, 4n);
    await setRepositoryInstallation(db, w.id, r.id, 1011n);
    await expect(db.workspaceInstallation.deleteMany({ where: { workspaceId: w.id, installationId: 1011n } })).rejects.toThrow();
    expect(await unbindInstallation(db, w.id, 1011n)).toBe(true);
    expect((await db.repository.findFirstOrThrow({ where: { id: r.id, workspaceId: w.id } })).installationId).toBeNull();
    expect(await loadBoundInstallation(db, w.id, 1011n)).toBeNull();
  });

  it("deleting a workspace still works with bound repositories (both tables cascade)", async () => {
    const w = await workspace("fk-cascade");
    await installation(1012n);
    await bind(w.id, 1012n);
    const r = await repo(w.id, 5n);
    await setRepositoryInstallation(db, w.id, r.id, 1012n);
    await db.workspace.delete({ where: { id: w.id } });
    expect(await db.repository.count({ where: { id: r.id, workspaceId: w.id } })).toBe(0);
    expect(await db.workspaceInstallation.count({ where: { workspaceId: w.id } })).toBe(0);
    expect(await db.githubInstallation.count({ where: { installationId: 1012n } })).toBe(1); // global row stays
  });

  it("the same installation can be bound by two workspaces, each repository tied to its own binding", async () => {
    const a = await workspace("share-a");
    const b = await workspace("share-b");
    await installation(1013n);
    await bind(a.id, 1013n);
    await bind(b.id, 1013n);
    expect(await setRepositoryInstallation(db, a.id, (await repo(a.id, 6n)).id, 1013n)).toBe(true);
    expect(await setRepositoryInstallation(db, b.id, (await repo(b.id, 6n)).id, 1013n)).toBe(true);
    await expect(db.workspaceInstallation.create({ data: { workspaceId: a.id, installationId: 1013n, verifiedAt: new Date(), verifiedGithubUserId: 1n, proofMethod: "x" } })).rejects.toThrow(); // unique
  });
});

describe("GithubAppState: single use, tied to a workspace", () => {
  const issue = async (workspaceId: string, hash: string, expiresAt: Date) =>
    db.githubAppState.create({ data: { workspaceId, userId: "u1", kind: "install", stateHash: hash, expiresAt } });

  it("two concurrent claims have exactly one winner", async () => {
    const w = await workspace("state-race");
    await issue(w.id, "h-race", new Date(Date.now() + 60_000));
    const results = await Promise.all(Array.from({ length: 6 }, () => claimAppState(db, { workspaceId: w.id, stateHash: "h-race" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ workspaceId: w.id, userId: "u1", kind: "install" });
    expect(await claimAppState(db, { workspaceId: w.id, stateHash: "h-race" })).toBeNull(); // used
  });

  it("an expired state claims nothing, and a state is not claimable through another workspace", async () => {
    const a = await workspace("state-a");
    const b = await workspace("state-b");
    await issue(a.id, "h-old", new Date(Date.now() - 1000));
    await issue(a.id, "h-live", new Date(Date.now() + 60_000));
    expect(await claimAppState(db, { workspaceId: a.id, stateHash: "h-old" })).toBeNull();
    expect(await claimAppState(db, { workspaceId: b.id, stateHash: "h-live" })).toBeNull();
    expect(await claimAppState(db, { workspaceId: a.id, stateHash: "h-live", now: new Date(Date.now() + 120_000) })).toBeNull(); // clock past expiry
    expect(await claimAppState(db, { workspaceId: a.id, stateHash: "h-live" })).not.toBeNull();
  });

  it("is removed with its workspace", async () => {
    const w = await workspace("state-cascade");
    await issue(w.id, "h-casc", new Date(Date.now() + 60_000));
    await db.workspace.delete({ where: { id: w.id } });
    expect(await db.githubAppState.count({ where: { workspaceId: w.id } })).toBe(0);
  });
});

describe("static: who may write Repository.installationId and issue a BoundInstallation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const BINDING = "src/lib/github/binding.ts";
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "generated" && e.name !== "node_modules") walk(rel);
      } else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(rel);
    }
  };
  beforeAll(() => {
    for (const d of ["src", "scripts"]) walk(d);
    files.push("prisma/seed.ts");
  });

  it("only binding.ts passes installationId to a Repository write", () => {
    const writes = /\.repository\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\(/g;
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(writes)) {
        const open = m.index! + m[0].length - 1;
        if (/installationId/.test(argsAt(src, open)) && f !== BINDING) offenders.push(`${f}: ${m[0]}`);
      }
      if (/(?:INSERT INTO|UPDATE)\s+"Repository"[^;]*installationId/i.test(src)) offenders.push(`${f}: raw SQL`);
    }
    expect(offenders).toEqual([]);
  });

  it("only binding.ts (and the bound-installation module itself) issues a BoundInstallation", () => {
    const offenders = files.filter((f) => f !== BINDING && f !== "src/lib/github/bound-installation.ts" && /makeBoundInstallation\(/.test(fs.readFileSync(path.join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
