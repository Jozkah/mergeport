// Run synchronously by tests/pg.ts: (re)creates database argv[2] as a copy of the migrated template.
import pg from "pg";

const name = process.argv[2];
if (!/^[a-z0-9_]+$/.test(name ?? "")) throw new Error("bad database name");
const c = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
await c.connect();
try {
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${name}" TEMPLATE "mergeport_template"`);
} finally {
  await c.end();
}
