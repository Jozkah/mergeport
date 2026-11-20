import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createPrisma, type Db } from "@/lib/db";

const BASE = process.env.DATABASE_URL!.replace(/\/[^/]*$/, "");

/**
 * A fresh, fully migrated database for one test (a copy of the template made by tests/global-setup.ts). `label` (what used
 * to be a SQLite file path) only names it: the same label always yields the same database name, recreated empty here.
 */
export function createTestPrisma(label: string, _opts?: unknown): Db {
  const name = "t_" + createHash("sha1").update(label).digest("hex").slice(0, 20);
  const r = spawnSync(process.execPath, [path.resolve("tests", "fixtures", "create-test-db.mjs"), name], {
    env: { ...process.env, TEST_ADMIN_URL: `${BASE}/postgres` },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`could not create test database ${name}: ${r.stderr}`);
  return createPrisma(`${BASE}/${name}`);
}
