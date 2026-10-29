import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(".data");
const removeClients = () => {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/^client-.*\.db(-wal|-shm|-journal)?$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
};

/** Fresh SQLite file per test run. Migrations are applied by createPrisma(). Per-client databases made by the two-client harness are removed afterwards. */
export default function setup() {
  const file = path.join(dir, "test.db");
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true });
  removeClients();
  return removeClients;
}
