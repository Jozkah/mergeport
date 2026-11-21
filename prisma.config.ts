import "dotenv/config";
import { defineConfig } from "prisma/config";

// DATABASE_URL (Postgres) is required by migrate commands. Runtime and start scripts apply migrations with `prisma migrate deploy`.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // No fallback URL: migrate commands need DATABASE_URL (they fail with Prisma's own message when it is missing); `prisma generate` does not.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
