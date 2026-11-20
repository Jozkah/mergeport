/**
 * Starts the development Postgres (native process, no Docker) and stays in the foreground:  npm run db:dev
 * Data lives in .data/pg (gitignored). Port 5433. Then:  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/mergeport
 * and `npx prisma migrate deploy` once. Ctrl+C stops it.
 */
import path from "node:path";
import { ensureDatabase, startEmbedded, urlFor } from "./pg-embedded";

const port = Number(process.env.MERGEPORT_PG_PORT ?? 5433);
const dir = path.resolve(process.env.MERGEPORT_PG_DIR ?? path.join(".data", "pg"));

const pg = await startEmbedded({ dir, port });
await ensureDatabase(pg, "mergeport");
console.log(`\nPostgres ready. DATABASE_URL=${urlFor(port, "mergeport")}\nApply migrations once:  npx prisma migrate deploy   (Ctrl+C to stop)`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30); // keep the process alive
