import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { decryptSecret, encryptSecret, parseKey } from "@/lib/federation/config";
import type { GithubAppConfig } from "./app-config";
import { refreshUserTokens, type ConnectDeps, type UserTokens } from "./connect-api";

/**
 * A person's own GitHub user-to-server token: stored encrypted, renewed on demand, never shown to a page.
 *
 *  - AES-256-GCM with MERGEPORT_ENCRYPTION_KEY (the helper the federation links use). The AAD names the person (`ghusertoken:<userId>`),
 *    so a ciphertext copied to another person's row does not decrypt. Without the key nothing here works and callers say so.
 *  - The lifetimes (access about 8 hours, refresh about 6 months) come from GitHub's token response and are stored as dates; this code
 *    assumes no number. A token GitHub gave no expiry for is used until GitHub refuses it.
 *  - Renewal is SINGLE FLIGHT per person: one in-process promise, and a row lock (SELECT ... FOR UPDATE) held for the exchange so two
 *    processes cannot both spend the same refresh token (GitHub rotates it). The new pair replaces the old one in the same update.
 *  - A refresh token GitHub refuses (or that has expired) marks the link RELINK: both ciphertexts are cleared, the person's cached
 *    repository access is deleted, and nothing tries again until they link again. A network failure or an App-level refusal changes
 *    nothing and is retried later (the callers are rate limited per person).
 *  - Tokens are only ever held in local variables of these functions: not logged, not in an error message, not returned to a page.
 */
export const userTokenKey = (): Buffer | null => parseKey(process.env.MERGEPORT_ENCRYPTION_KEY);
export const tokenAad = (userId: string) => `ghusertoken:${userId}`;
/** A token this close to its expiry is renewed first. */
export const EXPIRY_SKEW_MS = 60_000;

export type Tx = Db | Prisma.TransactionClient;
export type TokenResult = { kind: "ok"; token: string } | { kind: "none" } | { kind: "relink" } | { kind: "no-key" };

type Row = { accessEnc: string | null; refreshEnc: string | null; accessExpiresAt: Date | null; refreshExpiresAt: Date | null };

/** The encrypted columns for a token pair; the lifetimes are GitHub's. */
export function sealTokens(tokens: UserTokens, key: Buffer, userId: string, now: Date) {
  const aad = tokenAad(userId);
  return {
    accessEnc: encryptSecret(tokens.accessToken, key, aad),
    refreshEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key, aad) : null,
    accessExpiresAt: tokens.expiresInSeconds ? new Date(now.getTime() + tokens.expiresInSeconds * 1000) : null,
    refreshExpiresAt: tokens.refreshExpiresInSeconds ? new Date(now.getTime() + tokens.refreshExpiresInSeconds * 1000) : null,
  };
}

const usable = (row: Row, now: Date) => row.accessEnc !== null && (row.accessExpiresAt === null || row.accessExpiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime());

/** Stores (or replaces) the person's tokens as a working link. */
export async function storeUserTokens(tx: Tx, userId: string, tokens: UserTokens, key: Buffer, now: Date): Promise<void> {
  const data = { ...sealTokens(tokens, key, userId, now), status: "OK", accessCheckedAt: null };
  await tx.githubUserToken.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

/** Marks the link as needing a new sign-in on GitHub: no token is kept and no cached access remains (fail closed). Idempotent. */
export async function markRelink(tx: Tx, userId: string): Promise<void> {
  await tx.githubUserToken.updateMany({ where: { userId }, data: { status: "RELINK", accessEnc: null, refreshEnc: null, accessExpiresAt: null, refreshExpiresAt: null } });
  await tx.githubRepoAccess.deleteMany({ where: { userId } });
}

const inflight = new Map<string, Promise<TokenResult>>();

async function renewLocked(db: Db, config: Pick<GithubAppConfig, "clientId" | "clientSecret">, userId: string, deps: ConnectDeps, now: Date, key: Buffer, force: boolean): Promise<TokenResult> {
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GithubUserToken" WHERE "userId" = ${userId} FOR UPDATE`;
      if (locked.length === 0) return { kind: "none" };
      const row = await tx.githubUserToken.findUniqueOrThrow({ where: { userId } });
      if (row.status === "RELINK") return { kind: "relink" };
      // Someone else renewed while this call waited for the lock: use their token (never spend a rotated refresh token twice).
      if (!force && usable(row, now)) {
        const t = row.accessEnc ? decryptSecret(row.accessEnc, key, tokenAad(userId)) : null;
        if (t) return { kind: "ok", token: t };
      }
      const refresh = row.refreshEnc ? decryptSecret(row.refreshEnc, key, tokenAad(userId)) : null;
      if (!refresh || (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now.getTime())) {
        await markRelink(tx, userId);
        return { kind: "relink" };
      }
      const r = await refreshUserTokens(config, deps, refresh); // throws when GitHub cannot be reached: the transaction rolls back and nothing changed
      if (r === "rejected") {
        await markRelink(tx, userId);
        return { kind: "relink" };
      }
      await tx.githubUserToken.update({ where: { userId }, data: sealTokens(r, key, userId, now) }); // the new refresh token replaces the old one in this one update
      return { kind: "ok", token: r.accessToken };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/**
 * A working access token for this person, renewed first when it is (nearly) expired or when `force` says GitHub just refused it.
 * Throws only when GitHub cannot be reached while renewing (a typed GithubAppError from connect-api).
 */
export async function getUserAccessToken(db: Db, config: Pick<GithubAppConfig, "clientId" | "clientSecret">, userId: string, deps: ConnectDeps, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<TokenResult> {
  const key = userTokenKey();
  const row = await db.githubUserToken.findUnique({ where: { userId } });
  if (!row) return { kind: "none" };
  if (row.status === "RELINK") return { kind: "relink" };
  if (!key) return { kind: "no-key" };
  if (!opts.force && usable(row, now)) {
    const t = row.accessEnc ? decryptSecret(row.accessEnc, key, tokenAad(userId)) : null;
    if (t) return { kind: "ok", token: t };
    // The ciphertext does not open under this key (the key was changed, or the row was altered): it is of no use any more.
    await markRelink(db, userId);
    return { kind: "relink" };
  }
  const id = `${userId}:${opts.force ? "f" : "n"}`;
  const running = inflight.get(id);
  if (running) return running;
  const p = renewLocked(db, config, userId, deps, now, key, opts.force === true).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
