import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureDatabase, startEmbedded, urlFor } from "../scripts/pg-embedded";

export const TEST_PG_PORT = 5434;
const dir = path.resolve(".data", "pg-test");

const portBusy = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

/** A previous run that was killed leaves its postmaster running on this data dir: stop it before the dir is wiped. */
async function stopStale() {
  const pidFile = path.join(dir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10); // the first line of postmaster.pid is the pid
    if (Number.isInteger(pid) && pid > 0) {
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      } catch {
        /* not running any more */
      }
      for (let i = 0; i < 50 && (await portBusy(TEST_PG_PORT)); i++) await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (await portBusy(TEST_PG_PORT)) throw new Error(`Test Postgres port ${TEST_PG_PORT} is already in use by another process. Stop it (or the stale test postmaster for ${dir}) and run again.`);
}

/**
 * Self-contained test database: a separate embedded Postgres (own data dir, port 5434), wiped on every run.
 * `mergeport_template` gets the migrations once (prisma migrate deploy); `mergeport_test` and every per-test database
 * made by tests/pg.ts are cheap copies of it (CREATE DATABASE ... TEMPLATE). Everything is stopped and deleted in teardown.
 */
export default async function setup() {
  await stopStale();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pg = await startEmbedded({ dir, port: TEST_PG_PORT, quiet: true, fast: true });
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
