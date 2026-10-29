// Run as a separate process by tests/migrations-concurrent.test.ts: applies the migrations to the file named in argv[2].
import { applyMigrations } from "../../src/lib/db/migrate";

const r = applyMigrations(process.argv[2]);
console.log(JSON.stringify(r));
