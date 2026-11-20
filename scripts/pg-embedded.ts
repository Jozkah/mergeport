import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

/**
 * A real Postgres running as a native process (no Docker, no VM) via the `embedded-postgres` package.
 * Used for local development (scripts/dev-db.ts) and for the test suite (tests/global-setup.ts).
 */
export type EmbeddedOpts = { dir: string; port: number; quiet?: boolean };

export const PG_USER = "postgres";
export const PG_PASSWORD = "postgres";
export const urlFor = (port: number, database: string) => `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${database}`;

export async function startEmbedded({ dir, port, quiet }: EmbeddedOpts): Promise<EmbeddedPostgres> {
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: true,
    // Loopback only; fsync off is fine for a throwaway dev/test cluster but kept on for the dev one by the caller's choice of dir.
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=200"],
    onLog: quiet ? () => {} : (m) => console.log(m),
    onError: quiet ? () => {} : (m) => console.error(m),
  });
  if (!fs.existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
  await pg.start();
  return pg;
}

export async function ensureDatabase(pg: EmbeddedPostgres, name: string): Promise<void> {
  const client = pg.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!r.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
