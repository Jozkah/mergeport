import "dotenv/config";
import { defineConfig } from "prisma/config";
import { resolveDatabaseUrl } from "./src/lib/database-url";

// DATABASE_URL (or POSTGRES_PASSWORD with the bundled compose database) is required by migrate commands. Runtime and start scripts apply
// migrations with `prisma migrate deploy`.
const url = resolveDatabaseUrl();
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // No fallback URL: migrate commands need one (they fail with Prisma's own message when it is missing); `prisma generate` does not.
  ...(url ? { datasource: { url } } : {}),
});
