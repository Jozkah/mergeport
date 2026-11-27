import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveDatabaseUrl } from "@/lib/database-url";

declare global {
  var __prisma: PrismaClient | undefined;
}

export function databaseUrl(): string {
  const url = resolveDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set (nor POSTGRES_PASSWORD for the bundled compose database). Point it at a Postgres database, e.g. postgresql://postgres:postgres@127.0.0.1:5433/mergeport (npm run db:dev starts one).");
  return url;
}

/** Opens a Prisma client on a Postgres database. Schema changes are applied by `prisma migrate deploy`, never here. */
export function createPrisma(url: string = databaseUrl(), opts: { max?: number } = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: opts.max ?? 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }) });
}

/**
 * The process-wide client, created on first use (not at import: the build and scripts import this module without a database).
 * One client per process, cached on globalThis so hot reload does not open a second pool.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const client = (globalThis.__prisma ??= createPrisma());
    const v = Reflect.get(client, prop, client);
    return typeof v === "function" ? v.bind(client) : v;
  },
});
export type Db = PrismaClient;
