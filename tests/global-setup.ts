import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDatabase, startEmbedded, urlFor } from "../scripts/pg-embedded";

export const TEST_PG_PORT = 5434;
const dir = path.resolve(".data", "pg-test");

/**
 * Self-contained test database: a separate embedded Postgres (own data dir, port 5434), wiped on every run.
 * `mergeport_template` gets the migrations once (prisma migrate deploy); `mergeport_test` and every per-test database
 * made by tests/pg.ts are cheap copies of it (CREATE DATABASE ... TEMPLATE). Everything is stopped and deleted in teardown.
 */
export default async function setup() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pg = await startEmbedded({ dir, port: TEST_PG_PORT, quiet: true });
  await ensureDatabase(pg, "mergeport_template");
  execFileSync(process.execPath, [path.resolve("node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: urlFor(TEST_PG_PORT, "mergeport_template") },
    stdio: "pipe",
  });
  const admin = pg.getPgClient("postgres", "127.0.0.1");
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "mergeport_test" TEMPLATE "mergeport_template"');
  } finally {
    await admin.end();
  }
  return async () => {
    await pg.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
