import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPrisma } from "./pg";

/**
 * The migrations and prisma/schema.prisma describe the same database. `prisma migrate diff` compares a migrated database (the test
 * template, made by `migrate deploy`) with the schema; no shadow database is needed. Partial unique indexes (Member_one_owner,
 * Invitation_pending_key, AccessSpace_one_common, FederationLink_live_key) cannot be written in the schema; Prisma does not propose
 * dropping them, and this test proves the diff stays empty and that they exist.
 */
describe("migrations match the schema", () => {
  it("prisma migrate diff against the migrated template is empty, and the federation partial index exists", async () => {
    const url = process.env.DATABASE_URL!.replace(/\/[^/]*$/, "/mergeport_template");
    const out = execFileSync(process.execPath, [path.resolve("node_modules", "prisma", "build", "index.js"), "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(out).toContain("This is an empty migration");
    expect(out).not.toMatch(/DROP INDEX|CREATE TABLE|ALTER TABLE/);
    const db = createTestPrisma("migration-drift");
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'FederationLink_live_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/PENDING/);
    await db.$disconnect();
  }, 60_000);
});
