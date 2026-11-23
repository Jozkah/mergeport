/**
 * Production web server:  npm start  (after `prisma migrate deploy`)
 * Reads HOST (default 127.0.0.1) and MERGEPORT_PORT / PORT (default 3000), refuses a network-reachable bind without
 * MERGEPORT_PUBLIC_URL (src/lib/bind-address.ts), then runs `next start`. Signals pass through so the platform's stop is graceful.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveBind } from "../src/lib/bind-address";

let bind: { host: string; port: number };
try {
  bind = resolveBind();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
console.log(`Mergeport web: listening on ${bind.host}:${bind.port}`);
const child = spawn(process.execPath, [nextBin, "start", "-H", bind.host, "-p", String(bind.port)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
