import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "@/lib/db/migrate";

// A Prisma-style table rebuild (create new table, copy, DROP old, rename) must not cascade-delete child rows, and a
// migration that leaves a dangling reference must roll back with an error naming the table.
let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mp-migrate-fk-"));
  const dir = path.join(root, "migrations");
  const add = (name: string, sql: string) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "migration.sql"), sql);
  };
  add("001_init", `CREATE TABLE "Parent" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "Child" ("id" INTEGER PRIMARY KEY, "parentId" INTEGER NOT NULL, CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE);`);
  return { dir, add, file: path.join(root, "db.sqlite") };
}

// Same shape Prisma generates for a SQLite table rebuild (see prisma/migrations/*_local_first_spaces).
const rebuild = (filter: string) => `PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Parent" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "extra" TEXT);
INSERT INTO "new_Parent" ("id", "name") SELECT "id", "name" FROM "Parent" ${filter};
DROP TABLE "Parent";
ALTER TABLE "new_Parent" RENAME TO "Parent";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;`;

function seed(file: string) {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(`INSERT INTO "Parent" VALUES (1, 'a'), (2, 'b'); INSERT INTO "Child" VALUES (10, 1), (11, 1), (12, 2);`);
  db.close();
}

describe("migration runner and foreign keys", () => {
  it("keeps cascading child rows through a table-rebuild migration", () => {
    const { dir, add, file } = setup();
    applyMigrations(file, dir);
    seed(file);
    add("002_rebuild", rebuild(""));
    expect(applyMigrations(file, dir).applied).toEqual(["002_rebuild"]);
    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Child"`).get()).toEqual({ n: 3 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Parent"`).get()).toEqual({ n: 2 });
      expect(db.prepare(`SELECT 1 FROM pragma_table_info('Parent') WHERE name = 'extra'`).get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("rolls back a migration that leaves a dangling reference, naming the table", () => {
    const { dir, add, file } = setup();
    applyMigrations(file, dir);
    seed(file);
    add("002_drop_parent_2", rebuild(`WHERE "id" <> 2`));
    expect(() => applyMigrations(file, dir)).toThrow(/002_drop_parent_2 leaves dangling foreign keys: Child -> Parent/);
    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare(`SELECT name FROM _mergeport_migrations ORDER BY name`).all()).toEqual([{ name: "001_init" }]);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Parent"`).get()).toEqual({ n: 2 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Child"`).get()).toEqual({ n: 3 });
      expect(db.prepare(`SELECT 1 FROM pragma_table_info('Parent') WHERE name = 'extra'`).get()).toBeFalsy();
    } finally {
      db.close();
    }
  });
});
