/**
 * Production web server:  npm start  (after `prisma migrate deploy`)
 * Reads HOST (default 127.0.0.1) and MERGEPORT_PORT / PORT (default 3000), refuses a network-reachable bind without
 * MERGEPORT_PUBLIC_URL (src/lib/bind-address.ts), then runs `next start`. Signals pass through so the platform's stop is graceful.
 * Hosted, while nobody is server administrator, it first prints a single-use setup link (src/lib/auth/setup.ts).
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveBind } from "../src/lib/bind-address";
import { createPrisma } from "../src/lib/db";
import { isDemo } from "../src/lib/env";
import { announceSetupLink } from "../src/lib/auth/setup";
import { isHosted, publicOrigin } from "../src/lib/public-url";

let bind: { host: string; port: number };
try {
  bind = resolveBind();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

// A database problem here must not keep the web server down: it is logged and the server starts without a setup link.
if (isHosted() && !isDemo()) {
  let setupDb: ReturnType<typeof createPrisma> | null = null;
  try {
    setupDb = createPrisma(undefined, { max: 1 });
    await announceSetupLink(setupDb, publicOrigin()!.origin);
  } catch (e) {
    console.error(`Mergeport setup: could not create a setup link: ${e instanceof Error ? e.message : e}`);
  } finally {
    await setupDb?.$disconnect().catch(() => {});
  }
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
console.log(`Mergeport web: listening on ${bind.host}:${bind.port}`);
const child = spawn(process.execPath, [nextBin, "start", "-H", bind.host, "-p", String(bind.port)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
