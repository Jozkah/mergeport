import { createPrisma, type Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { ensureCommonSpace } from "@/lib/services/access-spaces";
import { seedDemo, truncateAll, type DemoIds } from "@/lib/demo/seed";

/** The (single) workspace of a test database. */
export const wsId = async (db: Db) => (await db.workspace.findFirstOrThrow({ orderBy: { createdAt: "asc" } })).id;

/** A fresh workspace with one administrator who has a GitHub identity: the smallest world a service test needs. */
export async function makeProfile(db: Db, who: { id: bigint; login: string; name?: string | null }) {
  const workspace = await db.workspace.create({ data: { name: "Test workspace" } });
  const user = await db.user.upsert({ where: { githubId: who.id }, create: { githubId: who.id, login: who.login, name: who.name ?? null }, update: {} });
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  await ensureCommonSpace(db, workspace.id);
  return { workspace, user, member };
}

export const BASE = new Date("2026-10-28T12:00:00Z");

let _db: Db | null = null;
export function testDb(): Db {
  return (_db ??= createPrisma());
}

export async function freshSeed(): Promise<{ db: Db; ids: DemoIds; admin: Viewer; a: Viewer; b: Viewer }> {
  const db = testDb();
  await truncateAll(db);
  const ids = await seedDemo(db, BASE);
  const [admin, a, b] = await Promise.all([loadViewer(db, ids.users.admin.id), loadViewer(db, ids.users.a.id), loadViewer(db, ids.users.b.id)]);
  return { db, ids, admin: admin!, a: a!, b: b! };
}

/** Recursively search any JSON-able value for a forbidden substring (used to prove nothing leaks). */
export function leaks(value: unknown, needle: string): boolean {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase().includes(needle.toLowerCase());
}
