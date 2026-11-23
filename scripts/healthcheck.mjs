// Container HEALTHCHECK: GET /api/health on the address the web process listens on. Exit 0 healthy, 1 not.
// The worker image role has no HTTP server: set MERGEPORT_ROLE=worker there and this exits 0 (liveness is the "worker" field of the web health JSON).
import { pathToFileURL } from "node:url";

/** URL to probe: the specific HOST / MERGEPORT_HOST the server bound, or loopback when it listens on all interfaces or HOST is unset. */
export function probeUrl(env = process.env) {
  let host = (env.MERGEPORT_HOST || env.HOST || "").trim();
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const port = (env.MERGEPORT_PORT || env.PORT || "3000").trim();
  return `http://${host}:${port}/api/health`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.MERGEPORT_ROLE === "worker") process.exit(0);
  try {
    const res = await fetch(probeUrl(), { signal: AbortSignal.timeout(4000) });
    process.exit(res.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
