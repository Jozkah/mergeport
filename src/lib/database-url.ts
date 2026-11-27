/**
 * The Postgres connection string. DATABASE_URL wins when set. Otherwise, with docker-compose.yml's bundled database, it is built from
 * POSTGRES_PASSWORD (user and database `mergeport`, host `postgres`, port 5432), so changing the password updates the URL too.
 * The password is percent-encoded here, so any characters work. No `@/` imports: prisma.config.ts loads this file outside Next.
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const password = env.POSTGRES_PASSWORD;
  if (!password) return undefined;
  return `postgresql://mergeport:${encodeURIComponent(password)}@postgres:5432/mergeport`;
}
