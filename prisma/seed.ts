import "dotenv/config";
import { createPrisma } from "../src/lib/db";
import { seedDemo, truncateAll } from "../src/lib/demo/seed";

/** Seeds synthetic demo data into the database named by MERGEPORT_DB (default ./.data/dev.db). Requires DEMO_MODE=true. */
async function main() {
  if (process.env.DEMO_MODE !== "true") {
    console.error("Refusing to seed: set DEMO_MODE=true. Demo data is synthetic and must stay separate from real profiles.");
    process.exit(1);
  }
  const db = createPrisma();
  const real = await db.repository.count({ where: { isDemo: false } });
  if (real > 0) {
    console.error(`Refusing to seed: ${real} non-demo repositories exist and seeding would delete them.`);
    process.exit(1);
  }
  await truncateAll(db);
  const ids = await seedDemo(db);
  console.log(`Seeded demo workspace "${ids.ws.name}".`);
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
