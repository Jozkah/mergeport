import "dotenv/config";
import { defineConfig } from "prisma/config";

// DATABASE_URL (Postgres) is required by migrate commands. Runtime and start scripts apply migrations with `prisma migrate deploy`.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5433/mergeport" },
});
