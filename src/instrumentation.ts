export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The job loop runs in its own process (`npm run worker`). Only the local launcher runs it inline in the web process.
  if (process.env.MERGEPORT_INLINE_WORKER !== "1") return;
  const { startLocalScheduler } = await import("@/lib/local/scheduler");
  startLocalScheduler();
}
