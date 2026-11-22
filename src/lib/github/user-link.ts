import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { ValidationError } from "@/lib/errors";
import { decryptSecret } from "@/lib/federation/config";
import { audit } from "@/lib/services/audit";
import { purgeDigests } from "@/lib/services/digest-purge";
import { requestAccessRefresh } from "./access-cache";
import { GithubAppError } from "./app-auth";
import type { GithubAppConfig } from "./app-config";
import { claimAppState } from "./app-state";
import { STATE_SHAPE, STATE_TTL_MS, challengeOf, connectOverrides, nonceHashOf } from "./connect";
import { GITHUB_WEB_BASE, exchangeCodeForTokens, getUser, revokeUserToken, type ConnectDeps, type GithubUser, type UserTokens } from "./connect-api";
import { NO_KEY_TEXT, type LinkResult } from "./link-messages";
import { storeUserTokens, tokenAad, userTokenKey } from "./user-token";

/**
 * Linking a person's GitHub account (docs/github-app.md, "Linking your GitHub account"). Same shape as the connect flow: a single-use
 * state row (hash only, bound to the person and the workspace they were in), a browser nonce in an HttpOnly cookie that doubles as the
 * PKCE verifier, and the GitHub App's user-to-server authorization. Unlike the connect flow the token IS kept (encrypted, user-token.ts):
 * it is how Mergeport asks GitHub what this person may open.
 *
 * The callback trusts nothing it is given. The GitHub account is whatever `GET /user` says for the token the code was exchanged for;
 * it is never matched to a person by email or by anything in the query. Two refusals protect against account takeover, and a refusal
 * writes nothing: the GitHub account is already linked to a DIFFERENT person, or this person already has a DIFFERENT GitHub account
 * linked (they must unlink first).
 */
export const LINK_COOKIE = "mp_gh_link";
/** The nonce cookie is only ever sent to the link callback. */
export const LINK_COOKIE_PATH = "/api/github/link";
export const LINK_CALLBACK_PATH = "/api/github/link/callback";
const RATE_WINDOW_MS = 10 * 60_000;
const START_MAX = 10;
const CALLBACK_MAX = 20;

export const linkRedirectUri = (publicOrigin: string) => `${publicOrigin.replace(/\/+$/, "")}${LINK_CALLBACK_PATH}`;

export type LinkViewer = { userId: string; workspaceId: string };

// ---------- start ----------

/** Mints the state and the browser nonce for the signed-in person and returns the GitHub address to go to. The caller sets the nonce cookie. */
export async function startLink(db: Db, input: { viewer: LinkViewer; config: GithubAppConfig; redirectUri: string; now?: Date }): Promise<{ url: string; nonce: string; maxAgeSeconds: number }> {
  const { viewer, config } = input;
  const now = input.now ?? new Date();
  if (!userTokenKey()) throw new ValidationError(NO_KEY_TEXT);
  const row = await db.githubUserToken.findUnique({ where: { userId: viewer.userId }, select: { status: true } });
  if (row?.status === "OK") throw new ValidationError("Your GitHub account is already linked.");
  if (!(await take(db, `ghlink:start:${viewer.userId}`, START_MAX, RATE_WINDOW_MS, now))) throw new ValidationError("Too many attempts. Wait a few minutes and try again.");

  const nonce = randomToken(32);
  const state = `${viewer.workspaceId}.${randomToken(32)}`;
  await db.githubAppState.deleteMany({ where: { workspaceId: viewer.workspaceId, userId: viewer.userId, kind: "link", expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } });
  await db.githubAppState.create({ data: { workspaceId: viewer.workspaceId, userId: viewer.userId, kind: "link", stateHash: sha256(state), nonceHash: nonceHashOf(nonce), expiresAt: new Date(now.getTime() + STATE_TTL_MS) } });
  const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: input.redirectUri, state, code_challenge: challengeOf(nonce), code_challenge_method: "S256", allow_signup: "false" });
  return { url: `${GITHUB_WEB_BASE}/login/oauth/authorize?${q.toString()}`, nonce, maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000) };
}

// ---------- callback ----------

export type LinkCallbackInput = {
  /** The signed-in person (from the session cookie). */
  userId: string;
  /** Raw query values: untrusted. */
  state: string | null;
  code: string | null;
  /** The browser's nonce cookie. */
  nonce: string | null;
  config: GithubAppConfig;
  redirectUri: string;
  deps?: ConnectDeps;
  now?: Date;
  /** Called once the state was successfully claimed (so the caller can drop the nonce cookie). */
  onClaimed?: () => void;
};

type Refusal = Exclude<LinkResult, "linked" | "invalid-link" | "no-key" | "cannot-verify" | "unavailable" | "app-problem" | "rate-limited" | "error">;

/** Writes the link in one transaction, or refuses without writing anything. */
export async function linkGithubAccount(db: Db, input: { userId: string; workspaceId: string; github: GithubUser; tokens: UserTokens; key: Buffer; now: Date }): Promise<"linked" | Refusal> {
  const { userId, workspaceId, github, tokens, key, now } = input;
  const subject = String(github.id);
  try {
    return await db.$transaction(async (tx) => {
      const me = await tx.user.findUnique({ where: { id: userId }, select: { githubId: true } });
      if (!me) return "other-account";
      if (me.githubId !== null && me.githubId !== github.id) return "other-account"; // this person already has a different GitHub account linked: unlink first
      const holder = await tx.user.findUnique({ where: { githubId: github.id }, select: { id: true } });
      if (holder && holder.id !== userId) return "github-taken"; // that GitHub account belongs to someone else here: never merge accounts
      const theirs = await tx.identity.findUnique({ where: { provider_subject: { provider: "github", subject } }, select: { userId: true } });
      if (theirs && theirs.userId !== userId) return "github-taken";
      const mine = await tx.identity.findFirst({ where: { userId, provider: "github" }, select: { subject: true } });
      if (mine && mine.subject !== subject) return "other-account";
      await tx.user.update({ where: { id: userId }, data: { githubId: github.id, githubLogin: github.login } });
      if (!theirs) await tx.identity.create({ data: { userId, provider: "github", subject } });
      await storeUserTokens(tx, userId, tokens, key, now);
      await audit(tx, { workspaceId, userId }, "github.link", { type: "User", id: userId }, { githubUserId: subject });
      return "linked";
    });
  } catch (e) {
    // Two people linking the same GitHub account at once: the unique keys let exactly one transaction commit.
    if ((e as { code?: string })?.code === "P2002") return "github-taken";
    throw e;
  }
}

/** Runs the callback and answers with ONE fixed result code. Nothing here returns or throws a value taken from the query or from GitHub. */
export async function completeLink(db: Db, input: LinkCallbackInput): Promise<LinkResult> {
  const now = input.now ?? new Date();
  const deps = input.deps ?? connectOverrides()?.deps ?? {};
  try {
    // A callback without a well-formed state costs nothing: a cross-site GET must not burn the signed-in person's quota.
    const shape = STATE_SHAPE.exec(input.state ?? "");
    if (!shape) return "invalid-link";
    if (!(await take(db, `ghlink:cb:${input.userId}`, CALLBACK_MAX, RATE_WINDOW_MS, now))) return "rate-limited";
    const claimed = await claimAppState(db, { workspaceId: shape[1], stateHash: sha256(input.state!), now });
    if (!claimed) return "invalid-link";
    input.onClaimed?.(); // only now is this browser's nonce cookie spent
    if (claimed.userId !== input.userId || claimed.kind !== "link") return "invalid-link";
    if (!input.nonce || !claimed.nonceHash || !safeEqual(nonceHashOf(input.nonce), claimed.nonceHash)) return "invalid-link";
    const member = await db.member.findFirst({ where: { userId: input.userId, workspaceId: claimed.workspaceId, status: "ACTIVE" }, select: { id: true } });
    if (!member) return "invalid-link";
    const key = userTokenKey();
    if (!key) return "no-key";
    if (!input.code) return "cannot-verify"; // the person declined on GitHub

    const tokens = await exchangeCodeForTokens(input.config, deps, { code: input.code, redirectUri: input.redirectUri, codeVerifier: input.nonce });
    if (!tokens) return "cannot-verify";
    let kept = false;
    try {
      const github = await getUser(deps, tokens.accessToken);
      if (!github) return "cannot-verify";
      const r = await linkGithubAccount(db, { userId: input.userId, workspaceId: claimed.workspaceId, github, tokens, key, now });
      if (r !== "linked") return r;
      kept = true;
      await requestAccessRefresh(db, input.userId).catch(() => {}); // the first check of what they can open; never blocks the link
      return "linked";
    } finally {
      if (!kept) await revokeUserToken(input.config, deps, tokens.accessToken); // a refused link keeps no token anywhere, GitHub's side included
    }
  } catch (e) {
    if (e instanceof GithubAppError) {
      if (e.code === "unavailable" || e.code === "rate_limited") return "unavailable";
      if (e.code === "app_misconfigured") return "app-problem";
    }
    console.error("github link failed", e instanceof Error ? e.name : "unknown");
    return "error";
  }
}

// ---------- unlink ----------

/**
 * Ends the person's own link. Revokes the token at GitHub (best effort), then in one transaction deletes the token, the GitHub identity,
 * every cached access row and the stored digests of the person (in every workspace they belong to) and clears `githubId` and
 * `githubLogin`. Safe to repeat. Returns whether anything was linked.
 */
export async function unlinkGithubAccount(db: Db, viewer: LinkViewer, config: Pick<GithubAppConfig, "clientId" | "clientSecret"> | null, deps: ConnectDeps = connectOverrides()?.deps ?? {}): Promise<boolean> {
  const row = await db.githubUserToken.findUnique({ where: { userId: viewer.userId }, select: { accessEnc: true } });
  const key = userTokenKey();
  if (row?.accessEnc && key && config) {
    const token = decryptSecret(row.accessEnc, key, tokenAad(viewer.userId));
    if (token) await revokeUserToken(config, deps, token);
  }
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const u = await tx.user.findUnique({ where: { id: viewer.userId }, select: { githubId: true } });
    const had = u?.githubId != null || row !== null;
    await tx.githubUserToken.deleteMany({ where: { userId: viewer.userId } });
    await tx.identity.deleteMany({ where: { userId: viewer.userId, provider: "github" } });
    await tx.githubRepoAccess.deleteMany({ where: { userId: viewer.userId } });
    await tx.user.updateMany({ where: { id: viewer.userId }, data: { githubId: null, githubLogin: null } });
    const memberships = await tx.member.findMany({ where: { userId: viewer.userId }, select: { workspaceId: true } });
    for (const m of memberships) await purgeDigests(tx, m.workspaceId, [viewer.userId]);
    if (had) await audit(tx, viewer, "github.unlink", { type: "User", id: viewer.userId });
    return had;
  });
}

