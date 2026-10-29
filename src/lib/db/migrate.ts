import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Applies prisma/migrations/*\/migration.sql to a SQLite file at startup, so running the app never needs the Prisma CLI.
 * Applied names are recorded in `_mergeport_migrations`. A database created by `prisma migrate dev` (which records
 * `_prisma_migrations`) is recognised, so developers can mix both.
 */

export type MigrationResult = { applied: string[]; alreadyApplied: number };

export function migrationsDir(): string {
  return process.env.MERGEPORT_MIGRATIONS ?? path.join(process.cwd(), "prisma", "migrations");
}

export function applyMigrations(dbFile: string, dir = migrationsDir()): MigrationResult {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS _mergeport_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set<string>(db.prepare("SELECT name FROM _mergeport_migrations").all().map((r) => (r as { name: string }).name));
    const hasPrisma = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get();
    if (hasPrisma) for (const r of db.prepare("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL").all() as { migration_name: string }[]) done.add(r.migration_name);

    // The app always runs from its own checkout, so migrations are read at run time; tell the bundler not to trace the tree.
    const names = fs.existsSync(/* turbopackIgnore: true */ dir) ? fs.readdirSync(/* turbopackIgnore: true */ dir).filter((n) => fs.existsSync(/* turbopackIgnore: true */ path.join(dir, n, "migration.sql"))).sort() : [];
    // A database that has migrations this build does not know is newer than the app: refuse rather than guess.
    const known = new Set(names);
    const unknown = [...done].filter((n) => !known.has(n));
    if (unknown.length) throw new Error(`This database was created by a newer Mergeport (unknown migrations: ${unknown.join(", ")}). Update the app.`);

    // Several processes can start at once (a build collects pages with many workers; two app instances). Each migration is
    // applied inside an IMMEDIATE transaction that re-checks the record after taking the write lock, so exactly one process
    // applies it and the others see it as done instead of failing with "table already exists".
    const isDone = db.prepare("SELECT 1 FROM _mergeport_migrations WHERE name = ?");
    const record = db.prepare("INSERT INTO _mergeport_migrations (name, applied_at) VALUES (?, ?)");
    const applyOne = db.transaction((n: string, sql: string) => {
      if (isDone.get(n)) return false;
      db.exec(sql);
      record.run(n, new Date().toISOString());
      return true;
    });
    db.pragma("busy_timeout = 30000");
    const applied: string[] = [];
    for (const n of names) {
      if (done.has(n)) continue;
      if (applyOne.immediate(n, fs.readFileSync(path.join(dir, n, "migration.sql"), "utf8"))) applied.push(n);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    db.close();
  }
}
