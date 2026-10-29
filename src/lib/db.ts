import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import { applyMigrations } from "@/lib/db/migrate";

declare global {
  var __prisma: PrismaClient | undefined;
  var __prismaTuned: boolean | undefined;
}

/** Absolute path of the SQLite file for this process. One process serves exactly one local profile. */
export function resolveDbFile(): string {
  const explicit = process.env.MERGEPORT_DB;
  if (explicit) return path.resolve(explicit.replace(/^file:/, ""));
  return path.resolve(process.cwd(), ".data", "dev.db");
}

/** Opens (and migrates) a SQLite database file. `migrate: false` is for callers that already ran migrations. */
export function createPrisma(file = resolveDbFile(), opts: { migrate?: boolean } = {}) {
  if (opts.migrate !== false) applyMigrations(file);
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}`, timeout: 10_000 }) });
}

export const db: PrismaClient = globalThis.__prisma ?? (globalThis.__prisma = createPrisma());
// Per-connection SQLite tuning (WAL itself is set when the file is migrated): safe with WAL, fewer fsyncs, bigger page cache.
if (!globalThis.__prismaTuned) {
  globalThis.__prismaTuned = true;
  for (const p of ["PRAGMA synchronous = NORMAL", "PRAGMA cache_size = -65536", "PRAGMA temp_store = MEMORY", "PRAGMA mmap_size = 268435456"]) void db.$queryRawUnsafe(p).catch(() => {});
}
export type Db = PrismaClient;
