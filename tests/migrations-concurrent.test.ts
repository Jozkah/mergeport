import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const file = path.resolve(".data", `client-migrate-${process.pid}.db`);
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
});

const run = () =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", path.resolve("tests", "fixtures", "apply-migrations.ts"), file], { encoding: "utf8", windowsHide: true }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

describe("starting several processes at once", () => {
  it("applies every migration exactly once and none of them fails (real processes)", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, run));
    for (const r of results) expect(r.err.includes("already exists") ? r.err : "").toBe("");
    expect(results.map((r) => r.code)).toEqual(Array(12).fill(0));
    const db = new Database(file, { readonly: true });
    try {
      const names = db.prepare("SELECT name FROM _mergeport_migrations ORDER BY name").all().map((r) => (r as { name: string }).name);
      const onDisk = fs.readdirSync("prisma/migrations").filter((n) => fs.existsSync(path.join("prisma/migrations", n, "migration.sql"))).sort();
      expect(names).toEqual(onDisk);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'DiscoveryCache'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  }, 60_000);
});
