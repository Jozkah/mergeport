import "dotenv/config";
import { defineConfig } from "prisma/config";

// Used by `prisma migrate dev` / `generate` only. At runtime the app opens each profile's own SQLite file through the
// better-sqlite3 driver adapter and applies the SQL migrations itself (src/lib/db/migrate.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "file:./.data/dev.db" },
});
