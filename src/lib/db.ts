import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

/**
 * Anchor path for per-install side files (the credential vault key lives next to it, see keyFileFor). Not a database any more:
 * the database is Postgres, named by DATABASE_URL. MERGEPORT_DB is only still read for this path (phase P3 removes it).
 */
export function resolveDbFile(): string {
  const explicit = process.env.MERGEPORT_DB;
  if (explicit) return path.resolve(explicit.replace(/^file:/, ""));
  return path.resolve(process.cwd(), ".data", "dev.db");
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Point it at a Postgres database, e.g. postgresql://postgres:postgres@127.0.0.1:5433/mergeport (npm run db:dev starts one).");
  return url;
}

/** Opens a Prisma client on a Postgres database. Schema changes are applied by `prisma migrate deploy`, never here. */
export function createPrisma(url: string = databaseUrl()): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10 }) });
}

export const db: PrismaClient = globalThis.__prisma ?? (globalThis.__prisma = createPrisma());
export type Db = PrismaClient;
