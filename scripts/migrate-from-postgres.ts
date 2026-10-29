/**
 * Imports a legacy centralized (Postgres) Mergeport database into a local SQLite profile.
 *
 *   npm run migrate:from-postgres -- --from postgresql://user:pass@host:5432/mergeport --login your-github-login [--to path/to/mergeport.db] [--dry-run]
 *
 * Only the rows YOU could already see are copied; credentials, sessions, devices and folder paths are not; nothing
 * becomes shared. The target must be empty. By default the database lands in your profile folder
 * (~/.mergeport/profiles/<host>-<your numeric GitHub id>/mergeport.db), which is where `npm run local` will look.
 * Read the printed report: it lists what was copied and what was left behind.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { createPrisma } from "../src/lib/db";
import { importLegacy, loadSchema, type LegacyRows } from "../src/lib/db/postgres-import";
import { mergeportHome, profileDbPath } from "../src/lib/local/profile";

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);

async function main() {
  const from = arg("--from") ?? process.env.LEGACY_DATABASE_URL;
  const login = arg("--login");
  if (!from || !login) {
    console.error("Usage: npm run migrate:from-postgres -- --from <postgres url> --login <github login> [--to <sqlite file>] [--dry-run]");
    process.exit(2);
  }
  const models = loadSchema();
  const pg = new Client({ connectionString: from });
  await pg.connect();
  const rows: LegacyRows = {};
  try {
    const tables = (await pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).rows.map((r) => String(r.table_name));
    for (const t of tables) if (!t.startsWith("_")) rows[t] = (await pg.query(`SELECT * FROM "${t.replace(/"/g, '""')}"`)).rows;
  } finally {
    await pg.end();
  }
  const u = (rows.User ?? []).find((x) => String(x.login).toLowerCase() === login.toLowerCase());
  if (!u) {
    console.error(`No user "${login}" in that database.`);
    process.exit(1);
  }
  const target = arg("--to") ?? profileDbPath(mergeportHome(process.env.MERGEPORT_HOME), process.env.MERGEPORT_HOST ?? "github.com", BigInt(u.githubId as string | number | bigint));
  if (args.includes("--dry-run")) {
    // A throwaway database so nothing is written to your profile.
    const tmp = path.join(path.dirname(target), `.dry-run-${process.pid}.db`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const db = createPrisma(tmp);
    try {
      console.log(JSON.stringify(await importLegacy(db, models, rows, { login }), null, 2));
    } finally {
      await db.$disconnect();
      for (const s of ["", "-wal", "-shm"]) fs.rmSync(tmp + s, { force: true });
    }
    console.log("Dry run: nothing was written to", target);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = createPrisma(target);
  try {
    console.log(JSON.stringify(await importLegacy(db, models, rows, { login }), null, 2));
  } finally {
    await db.$disconnect();
  }
  console.log("Imported into", target);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
