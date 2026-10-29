import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, type Db } from "@/lib/db";
import { importLegacy, loadSchema, parseSchema, type LegacyRows } from "@/lib/db/postgres-import";
import { freshSeed, leaks } from "./helpers";

const models = loadSchema();
const delegate = (db: Db, m: string) => (db as unknown as Record<string, { findMany(): Promise<Record<string, unknown>[]> }>)[m.charAt(0).toLowerCase() + m.slice(1)];

/** What node-postgres hands back: bigint columns as strings, timestamps as Date, json as parsed values. */
const pgShape = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

let legacy: LegacyRows;
const files: string[] = [];
const fresh = () => {
  const f = path.resolve(".data", `client-migration-${process.pid}-${files.length}.db`);
  files.push(f);
  return createPrisma(f);
};

beforeAll(async () => {
  const S = await freshSeed();
  legacy = {};
  for (const name of models.keys()) legacy[name] = (await delegate(S.db, name).findMany()).map(pgShape);
  // Rows only the legacy database had: a stored credential, a session and a paired device with a folder path.
  const alice = S.ids.users.a;
  legacy.GithubConnection = [{ id: "c1", userId: alice.id, kind: "USER_AUTH", encryptedToken: "v1.secret.secret.secret" }];
  legacy.Session = [{ id: "s1", userId: alice.id, tokenHash: "x" }];
  legacy.Device = [{ id: "d1", userId: alice.id, name: "old laptop", tokenHash: "x" }];
  // A legacy repository carried a connection id that no longer exists in the new schema.
  legacy.Repository = legacy.Repository.map((r) => ({ ...r, connectionId: "c1" }));
});
afterAll(() => {
  for (const f of files) for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
});

describe("schema parser", () => {
  it("finds scalar fields, enums and foreign keys", () => {
    const m = parseSchema(`enum Kind { A B }\nmodel Parent {\n  id String @id\n}\nmodel Child {\n  id String @id\n  parentId String?\n  kind Kind\n  at DateTime\n  big BigInt\n  parent Parent? @relation(fields: [parentId], references: [id])\n  tags Tag[]\n}`);
    const child = m.get("Child")!;
    expect(child.fields.map((f) => `${f.name}:${f.type}${f.optional ? "?" : ""}`)).toEqual(["id:String", "parentId:String?", "kind:Enum", "at:DateTime", "big:BigInt"]);
    expect(child.relations).toEqual([{ name: "parent", target: "Parent", from: ["parentId"], optional: true }]);
  });
});

describe("legacy Postgres import", () => {
  it("copies only what the person could see, never credentials, devices or sharing", async () => {
    const db = fresh();
    const report = await importLegacy(db, models, legacy, { login: "alice-demo" });
    expect(await db.user.count()).toBe(1);
    expect(await db.member.count()).toBe(1);
    expect((await db.member.findFirstOrThrow()).role).toBe("ADMIN"); // sole owner of the local profile
    const repos = await db.repository.findMany();
    expect(repos.length).toBe(3);
    expect(repos.some((r) => r.name === "internal-tools")).toBe(false); // alice never saw it
    expect(repos.every((r) => r.spaceId === null)).toBe(true); // nothing becomes shared
    expect((await db.project.findMany()).every((p) => p.spaceId === null)).toBe(true);
    for (const t of ["GithubConnection", "Session", "Device"]) expect(report.ignoredTables).toContain(t);
    expect(leaks(await db.user.findMany(), "secret")).toBe(false);
    expect(await db.device.count()).toBe(0);
    await db.$disconnect();
  });

  it("rebuilds the search indexes SQLite needs", async () => {
    const db = fresh();
    await importLegacy(db, models, legacy, { login: "owner-demo" });
    const labelled = await db.workItem.findMany({ where: { NOT: { labels: { equals: [] } } } });
    expect(labelled.length).toBeGreaterThan(0);
    for (const w of labelled) {
      const names = (w.labels as { name: string }[]).map((l) => l.name.toLowerCase());
      for (const n of names) expect(w.labelNames).toContain(`|${n}|`);
    }
    await db.$disconnect();
  });

  it("does not carry rows that hang off content the person could not see, nor other people's audit trail", async () => {
    const hidden = { ...legacy.Project[0], id: "p-hidden", name: "Hidden", slug: "hidden" }; // a project nobody gave this person
    const template = legacy.DashboardMilestone[0];
    const rows: LegacyRows = { ...legacy, Project: [...legacy.Project, hidden], DashboardMilestone: [...legacy.DashboardMilestone, { ...template, id: "ms-hidden", name: "Secret milestone", projectId: hidden.id }], AuditLog: [{ id: "a1", workspaceId: legacy.Workspace[0].id, actorUserId: legacy.User.find((u) => u.login === "alice-demo")!.id, action: "x", createdAt: new Date() }] };
    const db = fresh();
    const report = await importLegacy(db, models, rows, { login: "bram-demo" });
    expect(await db.dashboardMilestone.count({ where: { id: "ms-hidden" } })).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
    expect(report.dropped.DashboardMilestone).toBeGreaterThan(0);
    await db.$disconnect();
  });

  it("refuses a non-empty target and an unknown login", async () => {
    const db = fresh();
    await importLegacy(db, models, legacy, { login: "alice-demo" });
    await expect(importLegacy(db, models, legacy, { login: "alice-demo" })).rejects.toThrow(/not empty/);
    const other = fresh();
    await expect(importLegacy(other, models, legacy, { login: "nobody" })).rejects.toThrow(/No user/);
    await db.$disconnect();
    await other.$disconnect();
  });
});
