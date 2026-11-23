// Container HEALTHCHECK: GET /api/health on the port the web process listens on. Exit 0 healthy, 1 not.
// The worker image role has no HTTP server: set MERGEPORT_ROLE=worker there and this exits 0 (liveness is the "worker" field of the web health JSON).
if (process.env.MERGEPORT_ROLE === "worker") process.exit(0);
const port = (process.env.MERGEPORT_PORT || process.env.PORT || "3000").trim();
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
