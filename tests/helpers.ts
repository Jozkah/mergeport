import { createPrisma, type Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { seedDemo, truncateAll, type DemoIds } from "@/lib/demo/seed";

export const BASE = new Date("2026-10-28T12:00:00Z");

let _db: Db | null = null;
export function testDb(): Db {
  return (_db ??= createPrisma(process.env.MERGEPORT_DB));
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
