/**
 * Background job worker:  npm run worker
 * Runs the scheduler (coordination lane + job queue) in its own process, so the web process only serves pages. Several workers
 * can share one database: jobs are claimed atomically (see claim() in src/lib/jobs.ts).
 * It stamps a heartbeat row every 15 s that /api/health reports as worker: fresh | stale | unknown.
 * SIGINT/SIGTERM stop gracefully: the job in progress finishes (up to 30 s).
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { startLocalScheduler, stopLocalScheduler } from "../src/lib/worker/scheduler";
import { HEARTBEAT_EVERY_MS, beat } from "../src/lib/worker-heartbeat";

// The fake GitHub addresses (docs/dev-github-fake.md) are honoured only when NODE_ENV is development or test: without it this process quietly talks to the real github.com.
if ((process.env.MERGEPORT_GITHUB_API_BASE || process.env.MERGEPORT_GITHUB_WEB_BASE) && process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  console.warn("MERGEPORT_GITHUB_API_BASE / MERGEPORT_GITHUB_WEB_BASE are set but ignored: set NODE_ENV=development to use the fake GitHub.");
}

startLocalScheduler(5000);
console.log(`Mergeport worker started (pid ${process.pid}). Ctrl+C to stop.`);

const heartbeat = () => beat(db).catch((e) => console.error("heartbeat failed:", e instanceof Error ? e.message : e));
void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_EVERY_MS);

// The scheduler's timer is unref'd, so keep the process alive until a signal arrives (the heartbeat timer does that now, this is belt and braces).
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: finishing the current job, then exiting.`);
  clearInterval(keepAlive);
  clearInterval(heartbeatTimer);
  void stopLocalScheduler()
    .then(() => db.$disconnect())
    .catch((e) => console.error("shutdown failed:", e instanceof Error ? e.message : e))
    .finally(() => process.exit(0));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
