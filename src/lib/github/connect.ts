import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import { take } from "@/lib/auth/rate-limit";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, type Subject } from "@/lib/authz/roles";
import { GithubAppError } from "./app-auth";
import type { GithubAppConfig } from "./app-config";
import { claimAppState } from "./app-state";
import { bindInstallation, markInstallationState, refreshInstallationFacts, unbindInstallation, type InstallationFacts, type InstallationStatus } from "./binding";
import { exchangeCode, fetchInstallationFacts, getOrgMembership, getUser, listUserInstallations, revokeUserToken, GITHUB_WEB_BASE, type ConnectDeps, type GithubUser } from "./connect-api";
import type { ConnectResult } from "./connect-messages";

/**
 * Connecting a workspace to a GitHub App installation, with PROOF that the person controls it (docs/github-app.md).
 *
 * The App's user-to-server OAuth is used ONLY to prove control. The user token is held for the length of one callback, used for the
 * proof calls and discarded (and revoked at GitHub, best effort). It is never stored, logged or sent to a page.
 *
 * `startConnect` writes a single-use state row and hands back the GitHub address to send the browser to. The callback
 * (`completeConnect`) trusts nothing it is given: the installation id in the query is only a CLAIM that has to appear in the list GitHub
 * returns for this person's token, and control of that installation is then proved by a `ProofProvider`.
 */

export const CONNECT_COOKIE = "mp_gh_connect";
/** The nonce cookie is only ever sent to the callback. */
export const CONNECT_COOKIE_PATH = "/api/github/app";
export const CALLBACK_PATH = "/api/github/app/callback";
export const STATE_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const START_MAX = 15;
const CALLBACK_MAX = 20;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const STATE_SHAPE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,128})$/;
const INSTALLATION_ID = /^[1-9]\d{0,15}$/;

export const nonceHashOf = (nonce: string) => sha256(`ghconnect-nonce:${nonce}`);
/** PKCE S256 challenge for a verifier. The browser nonce doubles as the verifier (43 URL-safe characters, never sent to GitHub in the clear). */
export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export const connectRedirectUri = (publicOrigin: string) => `${publicOrigin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

// ---------- start ----------

export type StartMode = "install" | "existing";

/**
 * Mints the state and the browser nonce for the signed-in administrator and returns the GitHub address to go to. The caller (the server
 * action) sets the nonce as an HttpOnly cookie. `install` goes to the App's install page; `existing` goes to the OAuth authorize page
 * (with PKCE) so someone whose account already has the App installed can prove it.
 */
export async function startConnect(
  db: Db,
  input: { viewer: Subject & { workspaceId: string; userId: string }; mode: StartMode; account?: string | null; config: GithubAppConfig; redirectUri: string; now?: Date },
): Promise<{ url: string; nonce: string; maxAgeSeconds: number }> {
  const { viewer, config } = input;
  const now = input.now ?? new Date();
  if (!can(viewer, "manageGithub")) throw new ForbiddenError("Only the owner and administrators can connect GitHub.");
  let kind = "connect";
  if (input.mode === "existing") {
    const account = (input.account ?? "").trim();
    if (account && !LOGIN.test(account)) throw new ValidationError("Enter the GitHub account name, for example acme.");
    kind = account ? `connect-existing:${account}` : "connect-existing";
  }
  if (!(await take(db, `ghconnect:start:${viewer.userId}`, START_MAX, RATE_WINDOW_MS, now))) throw new ValidationError("Too many attempts. Wait a few minutes and try again.");

  const nonce = randomToken(32);
  const state = `${viewer.workspaceId}.${randomToken(32)}`;
  // Old rows of this person in this workspace are not needed any more.
  await db.githubAppState.deleteMany({ where: { workspaceId: viewer.workspaceId, userId: viewer.userId, expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } });
  await db.githubAppState.create({ data: { workspaceId: viewer.workspaceId, userId: viewer.userId, kind, stateHash: sha256(state), nonceHash: nonceHashOf(nonce), expiresAt: new Date(now.getTime() + STATE_TTL_MS) } });

  let url: string;
  if (input.mode === "install") {
    url = `${GITHUB_WEB_BASE}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  } else {
    const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: input.redirectUri, state, code_challenge: challengeOf(nonce), code_challenge_method: "S256", allow_signup: "false" });
    url = `${GITHUB_WEB_BASE}/login/oauth/authorize?${q.toString()}`;
  }
  return { url, nonce, maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000) };
}

// ---------- proof ----------

export type ProofRefusal = "not-yours" | "not-owner";
export type ProofOutcome = { ok: true; method: string } | { ok: false; reason: ProofRefusal };

/**
 * Decides whether the person behind a user token controls an installation. ANY doubt is a refusal, never a success. The organization
 * check depends on an endpoint whose behaviour for GitHub App user tokens is not verified live (docs/github-app.md, "needs a live
 * check"), which is why it sits behind this interface.
 */
export interface ProofProvider {
  prove(input: { deps: ConnectDeps; userToken: string; user: GithubUser; facts: InstallationFacts }): Promise<ProofOutcome>;
}

export const membershipProofProvider: ProofProvider = {
  async prove({ deps, userToken, user, facts }) {
    if (facts.accountType === "USER") return facts.accountGithubId === user.id ? { ok: true, method: "user-installations:self" } : { ok: false, reason: "not-yours" };
    if (facts.accountType === "ORGANIZATION") {
      const m = await getOrgMembership(deps, userToken, facts.accountLogin); // null for 403, 404 and anything unexpected
      return m && m.role === "admin" && m.state === "active" ? { ok: true, method: "user-installations:org-admin" } : { ok: false, reason: "not-owner" };
    }
    return { ok: false, reason: "not-yours" };
  },
};

// ---------- callback ----------

let testOverrides: { deps?: ConnectDeps; proof?: ProofProvider } | null = null;
/** Tests only: the fetch and proof provider the callback route uses. Refuses to run in production. */
export function setConnectOverridesForTests(o: { deps?: ConnectDeps; proof?: ProofProvider } | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("not available in production");
  testOverrides = o;
}
export const connectOverrides = () => testOverrides;

export type CallbackInput = {
  /** The signed-in person (from the session cookie). */
  userId: string;
  /** Raw query values: untrusted. */
  state: string | null;
  code: string | null;
  installationId: string | null;
  setupAction: string | null;
  /** The browser's nonce cookie. */
  nonce: string | null;
  config: GithubAppConfig;
  redirectUri: string;
  deps?: ConnectDeps;
  proof?: ProofProvider;
  now?: Date;
  /** Called once the state was successfully claimed (so the caller can drop the nonce cookie). Not called for malformed, unknown, used or expired states. */
  onClaimed?: () => void;
};

/** Runs the callback and answers with ONE fixed result code. Nothing here returns or throws a value taken from the query or from GitHub. */
export async function completeConnect(db: Db, input: CallbackInput): Promise<ConnectResult> {
  const now = input.now ?? new Date();
  const deps = input.deps ?? testOverrides?.deps ?? {};
  const proofProvider = input.proof ?? testOverrides?.proof ?? membershipProofProvider;
  try {
    // A callback without a well-formed state costs nothing: a cross-site GET must not burn the signed-in person's quota.
    const shape = STATE_SHAPE.exec(input.state ?? "");
    if (!shape) return "invalid-link";
    if (!(await take(db, `ghconnect:cb:${input.userId}`, CALLBACK_MAX, RATE_WINDOW_MS, now))) return "rate-limited";
    // The workspace id at the front is untrusted: it only picks the row to try. The whole value is hashed and claimed once.
    const claimed = await claimAppState(db, { workspaceId: shape[1], stateHash: sha256(input.state!), now });
    if (!claimed) return "invalid-link";
    input.onClaimed?.(); // only now is this browser's nonce cookie spent
    if (claimed.userId !== input.userId) return "invalid-link";
    if (!input.nonce || !claimed.nonceHash || !safeEqual(nonceHashOf(input.nonce), claimed.nonceHash)) return "invalid-link";

    const member = await db.member.findFirst({ where: { userId: input.userId, workspaceId: claimed.workspaceId, status: "ACTIVE" }, select: { role: true } });
    if (!member || !can({ role: member.role }, "manageGithub")) return "not-allowed";

    const existing = claimed.kind === "connect-existing" || claimed.kind.startsWith("connect-existing:");
    if (!existing && claimed.kind !== "connect") return "invalid-link";
    const wantedAccount = claimed.kind.startsWith("connect-existing:") ? claimed.kind.slice("connect-existing:".length) : null;

    let claimedId: bigint | null = null;
    if (!existing) {
      if (input.setupAction === "request") return "request-pending";
      if (!input.code) return "no-authorization";
      if (!input.installationId || !INSTALLATION_ID.test(input.installationId)) return "cannot-verify";
      claimedId = BigInt(input.installationId);
    } else if (!input.code) return "cannot-verify"; // the person declined on GitHub

    const token = await exchangeCode(input.config, deps, { code: input.code, redirectUri: input.redirectUri, codeVerifier: existing ? input.nonce : undefined });
    if (!token) return "cannot-verify";
    try {
      const user = await getUser(deps, token);
      const list = user ? await listUserInstallations(deps, token) : null;
      if (!user || !list) return "cannot-verify";

      let pick: (typeof list)[number] | undefined;
      if (!existing) pick = list.find((i) => i.id === claimedId); // the claim must be one of the installations GitHub shows this person
      else {
        const matches = wantedAccount ? list.filter((i) => i.accountLogin.toLowerCase() === wantedAccount.toLowerCase()) : list;
        if (matches.length > 1) return "several";
        pick = matches[0];
        if (!pick) return wantedAccount || list.length === 0 ? "not-found" : "cannot-verify";
      }
      if (!pick) return "cannot-verify";

      const facts = await fetchInstallationFacts(input.config, deps, pick.id, now.getTime());
      if (!facts) return "not-found";
      if (facts.accountGithubId !== pick.accountId || facts.accountType !== pick.accountType) return "cannot-verify";
      if (facts.suspendedAt) return "suspended";

      const proof = await proofProvider.prove({ deps, userToken: token, user, facts });
      if (!proof.ok) return proof.reason;

      const r = await bindInstallation(db, { workspaceId: claimed.workspaceId, connectedByUserId: input.userId, facts, proof: { githubUserId: user.id, method: proof.method }, now });
      return r.created ? "connected" : "already";
    } finally {
      await revokeUserToken(input.config, deps, token); // best effort; the token is not kept either way
    }
  } catch (e) {
    if (e instanceof GithubAppError) {
      if (e.code === "unavailable" || e.code === "rate_limited") return "unavailable";
      if (e.code === "app_misconfigured") return "app-problem";
    }
    console.error("github connect failed", e instanceof Error ? e.name : "unknown");
    return "error";
  }
}

// ---------- disconnect, check again ----------

/** Removes the workspace's binding (repositories stay, but are no longer connected; planning data is untouched). */
export async function disconnectInstallation(db: Db, viewer: Subject & { workspaceId: string; userId: string }, installationId: bigint): Promise<void> {
  if (!can(viewer, "manageGithub")) throw new ForbiddenError("Only the owner and administrators can disconnect GitHub.");
  const done = await unbindInstallation(db, viewer.workspaceId, installationId, viewer.userId);
  if (!done) throw new NotFoundError();
}

/**
 * "Check again": asks GitHub (as the App) about one installation of THIS workspace and records the answer. Needed because a suspended
 * installation is not used until someone looks again (webhooks will do this later). Returns the status after the check.
 */
export async function checkInstallation(
  db: Db,
  viewer: Subject & { workspaceId: string; userId: string },
  installationId: bigint,
  config: GithubAppConfig,
  deps: ConnectDeps = testOverrides?.deps ?? {},
): Promise<InstallationStatus> {
  if (!can(viewer, "manageGithub")) throw new ForbiddenError("Only the owner and administrators can do that.");
  const bound = await db.workspaceInstallation.findFirst({ where: { workspaceId: viewer.workspaceId, installationId }, select: { id: true } });
  if (!bound) throw new NotFoundError();
  try {
    const facts = await fetchInstallationFacts(config, deps, installationId);
    if (!facts) {
      await markInstallationState(db, installationId, "deleted");
      return "removed";
    }
    await refreshInstallationFacts(db, facts);
    return facts.suspendedAt ? "suspended" : "active";
  } catch (e) {
    if (e instanceof GithubAppError && e.code === "app_misconfigured") throw new ValidationError("GitHub rejected this server’s App settings. Tell the person who runs this server.");
    if (e instanceof GithubAppError) throw new ValidationError("GitHub did not answer. Try again in a minute.");
    throw e;
  }
}
