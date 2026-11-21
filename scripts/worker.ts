/**
 * Background job worker:  npm run worker
 * Runs the scheduler (coordination lane + job queue) in its own process, so the web process only serves pages. Several workers
 * can share one database: jobs are claimed atomically (see claim() in src/lib/jobs.ts).
 * SIGINT/SIGTERM stop gracefully: the job in progress finishes (up to 30 s), then any gh process still running is killed.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { startLocalScheduler, stopLocalScheduler } from "../src/lib/local/scheduler";

startLocalScheduler(5000, { ownSignals: false });
console.log(`Mergeport worker started (pid ${process.pid}). Ctrl+C to stop.`);

// The scheduler's timer is unref'd, so keep the process alive until a signal arrives.
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: finishing the current job, then exiting.`);
  clearInterval(keepAlive);
  void stopLocalScheduler()
    .then(() => db.$disconnect())
    .catch((e) => console.error("shutdown failed:", e instanceof Error ? e.message : e))
    .finally(() => process.exit(0));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
