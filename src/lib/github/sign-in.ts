import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { loginFromEmail, normalizeEmail, withUniqueRetry } from "@/lib/auth/accounts";
import { take } from "@/lib/auth/rate-limit";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/http";
import { isHosted, publicOrigin } from "@/lib/public-url";
import { audit } from "@/lib/services/audit";
import { requestAccessRefresh } from "./access-cache";
import { GithubAppError } from "./app-auth";
import { githubAppConfig, type GithubAppConfig } from "./app-config";
import { STATE_SHAPE, STATE_TTL_MS, connectOverrides, nonceHashOf } from "./connect";
import { exchangeCodeForTokens, getUser, getVerifiedPrimaryEmail, oauthAuthorizeUrl, revokeUserToken, type ConnectDeps, type GithubUser, type UserTokens } from "./connect-api";
import { storeUserTokens, userTokenKey } from "./user-token";
import { joinThroughGithubNow } from "./user-access";

/**
 * "Sign in with GitHub" for a hosted deployment (docs/github-app.md, "Signing in with GitHub"). It uses the deployment's own GitHub App
 * (user-to-server OAuth, the same App and callback machinery as linking an account) and nothing else: no new secret, no extra variable.
 *
 * Who the person is: the NUMERIC GitHub id from `GET /user` for the token the code was exchanged for. A login (a name that can be
 * released and reused) and anything in the query are never used as an identity. Rules, in order:
 *  1. The id is already linked to a person (Identity `github`, or `User.githubId`): that person signs in. The email is never consulted.
 *  2. Unknown id, GitHub's PRIMARY address and GitHub says it is verified, and NO account here has that address: a new person is created
 *     (email verified, like a magic link, so invitations to that address are waiting on /onboarding) and the id is linked.
 *  3. Unknown id, but an account here already holds that address: NOTHING is linked and nobody is signed in. Anyone who controls a
 *     GitHub account with that verified address could otherwise take over the existing account the day this flow met it, so the
 *     person is told to sign in with the email link first and link GitHub from Settings. The refusal is audited.
 *  4. No verified primary address: refused.
 *
 * State is single use (a row, hash only) and the browser nonce cookie doubles as the PKCE verifier, exactly as in the link flow.
 * The user token is kept (encrypted, user-token.ts) only when someone was signed in; any other ending revokes it at GitHub.
 */
export const SIGNIN_COOKIE = "mp_gh_signin";
/** The nonce cookie is only ever sent to the sign-in callback. */
export const SIGNIN_COOKIE_PATH = "/api/github/signin";
export const SIGNIN_START_PATH = "/api/github/signin/start";
export const SIGNIN_CALLBACK_PATH = "/api/github/signin/callback";
const RATE_WINDOW_MS = 10 * 60_000;
const START_MAX = 20;
const CALLBACK_MAX = 20;
const STATE_PREFIX = "signin";

export const signinRedirectUri = (origin: string) => `${origin.replace(/\/+$/, "")}${SIGNIN_CALLBACK_PATH}`;

/** True when this deployment can offer the button: hosted, the App configured, and the key that seals the user token present. */
export function githubSignInEnabled(): boolean {
  return isHosted() && publicOrigin() !== null && githubAppConfig() !== null && userTokenKey() !== null;
}

// ---------- start ----------

export async function startSignIn(db: Db, input: { config: GithubAppConfig; redirectUri: string; ip: string; next?: string | null; now?: Date }): Promise<{ url: string; nonce: string; maxAgeSeconds: number } | "rate-limited"> {
  const now = input.now ?? new Date();
  if (!(await take(db, `auth:ghsi:start:${sha256(input.ip)}`, START_MAX, RATE_WINDOW_MS, now))) return "rate-limited";
  const nonce = randomToken(32);
  const state = `${STATE_PREFIX}.${randomToken(32)}`;
  await db.githubSigninState.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } }); // housekeeping; the index makes it cheap
  await db.githubSigninState.create({ data: { stateHash: sha256(state), nonceHash: nonceHashOf(nonce), next: safeReturnTo(input.next), expiresAt: new Date(now.getTime() + STATE_TTL_MS) } });
  return { url: oauthAuthorizeUrl(input.config, { redirectUri: input.redirectUri, state, nonce }), nonce, maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000) };
}

// ---------- callback ----------

/** Each is a fixed code; the callback redirects to `/sign-in?error=github-<code>` and nothing from GitHub or the query is shown. */
export const SIGNIN_FAILURES = ["invalid", "declined", "no-email", "email-taken", "no-key", "unavailable", "app-problem", "rate-limited", "error"] as const;
export type SigninFailure = (typeof SIGNIN_FAILURES)[number];
export type SigninResult = { ok: true; userId: string; next: string; created: boolean } | { ok: false; reason: SigninFailure };

export type SigninCallbackInput = {
  /** Raw query values: untrusted. */
  state: string | null;
  code: string | null;
  /** The browser's nonce cookie. */
  nonce: string | null;
  /** The client address from the trusted proxy chain. */
  ip: string;
  config: GithubAppConfig;
  redirectUri: string;
  deps?: ConnectDeps;
  now?: Date;
  /** Called once the state was successfully claimed (so the caller can drop the nonce cookie). */
  onClaimed?: () => void;
};

/** One audit row per workspace the person is an ACTIVE member of (the audit log is per workspace; a brand-new person has none yet). */
async function auditForMemberships(tx: Prisma.TransactionClient, userId: string, action: string, meta: Prisma.InputJsonValue) {
  const memberships = await tx.member.findMany({ where: { userId, status: "ACTIVE" }, select: { workspaceId: true } });
  for (const m of memberships) await audit(tx, { workspaceId: m.workspaceId, userId }, action, { type: "User", id: userId }, meta);
}

type Resolved = { kind: "signed-in"; userId: string; created: boolean } | { kind: "email-taken"; holderId: string };

/**
 * The account rules, in one transaction. A race of two first sign-ins for the same GitHub id ends in a unique violation; the caller
 * retries once and the second run finds the first one's row.
 */
export async function resolveGithubSignIn(tx: Prisma.TransactionClient, input: { github: GithubUser; email: string | null; tokens: UserTokens; key: Buffer; now: Date }): Promise<Resolved | { kind: "no-email" }> {
  const { github, email, tokens, key, now } = input;
  const subject = String(github.id);
  const identity = await tx.identity.findUnique({ where: { provider_subject: { provider: "github", subject } }, select: { userId: true } });
  const holder = identity ? { id: identity.userId } : await tx.user.findUnique({ where: { githubId: github.id }, select: { id: true } });
  if (holder) {
    // Rule 1. Refresh what GitHub says about the account and make sure both link records exist; a sign-in is also a fresh authorization.
    await tx.user.update({ where: { id: holder.id }, data: { githubId: github.id, githubLogin: github.login } });
    if (!identity) await tx.identity.create({ data: { userId: holder.id, provider: "github", subject } });
    await storeUserTokens(tx, holder.id, tokens, key, now);
    await auditForMemberships(tx, holder.id, "github.signin", { githubUserId: subject });
    return { kind: "signed-in", userId: holder.id, created: false };
  }
  if (!email) return { kind: "no-email" };
  // Rule 3: any account that holds this address (as its email, or as an email identity) blocks the flow.
  const byEmail = await tx.user.findUnique({ where: { email }, select: { id: true } });
  const byIdentity = byEmail ? null : await tx.identity.findUnique({ where: { provider_subject: { provider: "email", subject: email } }, select: { userId: true } });
  const taken = byEmail?.id ?? byIdentity?.userId;
  if (taken) {
    await auditForMemberships(tx, taken, "github.signin_refused", { githubUserId: subject, reason: "email-taken" });
    return { kind: "email-taken", holderId: taken };
  }
  // Rule 2.
  const u = await tx.user.create({
    data: {
      login: github.login || loginFromEmail(email),
      githubId: github.id,
      githubLogin: github.login,
      email,
      emailVerifiedAt: now,
      identities: { create: [{ provider: "email", subject: email, email }, { provider: "github", subject }] },
    },
    select: { id: true },
  });
  await storeUserTokens(tx, u.id, tokens, key, now);
  return { kind: "signed-in", userId: u.id, created: true };
}

/** Runs the callback and answers with ONE fixed result. Nothing here returns or throws a value taken from the query or from GitHub. */
export async function completeSignIn(db: Db, input: SigninCallbackInput): Promise<SigninResult> {
  const now = input.now ?? new Date();
  const deps = input.deps ?? connectOverrides()?.deps ?? {};
  try {
    // A callback without a well-formed state costs nothing: a cross-site GET must not burn anyone's quota.
    const shape = STATE_SHAPE.exec(input.state ?? "");
    if (!shape || shape[1] !== STATE_PREFIX) return { ok: false, reason: "invalid" };
    if (!(await take(db, `auth:ghsi:cb:${sha256(input.ip)}`, CALLBACK_MAX, RATE_WINDOW_MS, now))) return { ok: false, reason: "rate-limited" };
    // The claim is one conditional UPDATE: of any number of simultaneous callbacks with this state exactly one wins.
    const stateHash = sha256(input.state!);
    const claimedRows = await db.githubSigninState.updateMany({ where: { stateHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimedRows.count !== 1) return { ok: false, reason: "invalid" };
    const row = await db.githubSigninState.findUnique({ where: { stateHash }, select: { nonceHash: true, next: true } });
    input.onClaimed?.(); // only now is this browser's nonce cookie spent
    if (!row || !input.nonce || !safeEqual(nonceHashOf(input.nonce), row.nonceHash)) return { ok: false, reason: "invalid" };
    const key = userTokenKey();
    if (!key) return { ok: false, reason: "no-key" };
    if (!input.code) return { ok: false, reason: "declined" }; // the person cancelled on GitHub

    const tokens = await exchangeCodeForTokens(input.config, deps, { code: input.code, redirectUri: input.redirectUri, codeVerifier: input.nonce });
    if (!tokens) return { ok: false, reason: "declined" };
    let kept = false;
    try {
      const github = await getUser(deps, tokens.accessToken);
      if (!github) return { ok: false, reason: "declined" };
      // Rule 1 needs no address, so GitHub's email endpoint is only asked about ids nobody here has linked yet.
      const linked = await db.identity.findUnique({ where: { provider_subject: { provider: "github", subject: String(github.id) } }, select: { id: true } });
      const legacy = linked ? null : await db.user.findUnique({ where: { githubId: github.id }, select: { id: true } });
      let email: string | null = null;
      if (!linked && !legacy) {
        const got = await getVerifiedPrimaryEmail(deps, tokens.accessToken);
        if (got.kind === "forbidden") return { ok: false, reason: "app-problem" };
        email = normalizeEmail(got.email); // GitHub already says verified; an address we cannot normalize is not one we can trust either
      }
      const r = await withUniqueRetry(() => db.$transaction((tx) => resolveGithubSignIn(tx, { github, email, tokens, key, now })));
      if (r.kind === "no-email") return { ok: false, reason: "no-email" };
      if (r.kind === "email-taken") {
        console.warn("[auth] GitHub sign-in refused: an account already holds the verified address of this GitHub account");
        return { ok: false, reason: "email-taken" };
      }
      kept = true;
      // Someone in no workspace yet is checked at once (an organization member then skips /onboarding); everyone else is queued.
      // Neither ever blocks sign-in.
      const joined = await joinThroughGithubNow(db, r.userId, { config: input.config, deps, now }).catch(() => false);
      if (!joined) await requestAccessRefresh(db, r.userId).catch(() => {});
      return { ok: true, userId: r.userId, next: safeReturnTo(row.next), created: r.created };
    } finally {
      if (!kept) await revokeUserToken(input.config, deps, tokens.accessToken); // a refused sign-in keeps no token anywhere, GitHub's side included
    }
  } catch (e) {
    if (e instanceof GithubAppError) {
      if (e.code === "unavailable" || e.code === "rate_limited") return { ok: false, reason: "unavailable" };
      if (e.code === "app_misconfigured") return { ok: false, reason: "app-problem" };
    }
    console.error("github sign-in failed", e instanceof Error ? e.name : "unknown");
    return { ok: false, reason: "error" };
  }
}
