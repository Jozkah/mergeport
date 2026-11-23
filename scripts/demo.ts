/**
 * Runs Mergeport on synthetic demo data:  npm run demo
 *
 * Needs a Postgres named by DATABASE_URL (`npm run db:dev` starts one). Applies pending migrations, seeds the demo workspace when the
 * database has no users yet, then starts the dev server on 127.0.0.1 with DEMO_MODE=true. Demo mode never contacts GitHub; sign in
 * from the demo people on /sign-in. Refuses a database that already holds real data.
 */
import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { createPrisma, databaseUrl } from "../src/lib/db";
import { seedDemo } from "../src/lib/demo/seed";

const port = process.env.MERGEPORT_PORT ?? "3000";

async function main() {
  databaseUrl(); // fails with a pointer to `npm run db:dev` when DATABASE_URL is missing
  execFileSync(process.execPath, [path.resolve("node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], { stdio: "inherit" });
  const db = createPrisma();
  try {
    const real = await db.repository.count({ where: { isDemo: false } });
    if (real > 0) {
      console.error(`Refusing to run demo mode on this database: it holds ${real} real repositories. Use an empty database.`);
      process.exit(1);
    }
    if ((await db.user.count()) === 0) await seedDemo(db);
  } finally {
    await db.$disconnect();
  }
  console.log(`Demo mode: synthetic data, no GitHub access. Open http://127.0.0.1:${port}/sign-in`);
  const child = spawn(process.execPath, [path.resolve("node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", port], {
    stdio: "inherit",
    env: { ...process.env, DEMO_MODE: "true" },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
