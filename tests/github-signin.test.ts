import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, locationOf, pathOf, request, state } from "./auth-mocks";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import { AccountSignIn } from "@/components/forms/AccountSignIn";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { userForVerifiedEmail } from "@/lib/auth/accounts";
import { loadViewer } from "@/lib/authz/viewer";
import { decryptSecret } from "@/lib/federation/config";
import { githubAppConfig, resetGithubAppConfigCache } from "@/lib/github/app-config";
import { setConnectOverridesForTests } from "@/lib/github/connect";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { SIGNIN_COOKIE, SIGNIN_COOKIE_PATH, SIGNIN_FAILURES, completeSignIn, githubSignInEnabled } from "@/lib/github/sign-in";
import { tokenAad } from "@/lib/github/user-token";
import { createInvitation, acceptInvitationById, pendingInvitationsFor } from "@/lib/services/invitations";
import { RecordingMailer } from "./auth-mocks";
import { proxy } from "@/proxy";

vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: m.HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

import { GET as signinStart } from "@/app/api/github/signin/start/route";
import { GET as signinCallback } from "@/app/api/github/signin/callback/route";

const CLIENT_ID = "Iv1.testclient01";
const CLIENT_SECRET = "client-secret-0123456789-abcdef";
const ENC_KEY = "k".repeat(40);
const REDIRECT = `${ORIGIN}/api/github/signin/callback`;
const IP = "203.0.113.7";

let fake: FakeGitHubServer;
let app: ReturnType<FakeGitHubServer["registerApp"]>;
let n = 0;
let logs: string[];
let spies: ReturnType<typeof vi.spyOn>[];

function configure() {
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", ENC_KEY);
  vi.stubEnv("MERGEPORT_GITHUB_APP_ID", app.appId);
  vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", app.privateKeyPem);
  vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "w".repeat(32));
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "mergeport-test");
  resetGithubAppConfigCache();
}

beforeEach(() => {
  state.db = createTestPrisma(`github-signin-${n++}`);
  state.jar.clear();
  fake = new FakeGitHubServer();
  app = fake.registerApp("12345");
  fake.setOAuthClient(CLIENT_ID, CLIENT_SECRET);
  configure();
  setConnectOverridesForTests({ deps: { fetch: fake.appFetch() } });
  logs = [];
  spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
});
afterEach(async () => {
  setConnectOverridesForTests(null);
  vi.unstubAllEnvs();
  resetGithubAppConfigCache();
  for (const s of spies) s.mockRestore();
  await state.db!.$disconnect();
});
const db = () => state.db!;
const key = () => Buffer.from(createHash("sha256").update(Buffer.from(ENC_KEY, "utf8")).digest());

// ---------- helpers ----------

const withIp = (ip = IP) => ({ "x-forwarded-for": ip });
/** Presses "Continue with GitHub": the address the browser would be sent to and the nonce it keeps. */
async function begin(next?: string, ip = IP) {
  const res = await signinStart(request(`/api/github/signin/start${next ? `?next=${encodeURIComponent(next)}` : ""}`, { headers: withIp(ip) }));
  if (res.status !== 302) throw new Error(`start answered ${res.status} ${locationOf(res)}`);
  const url = new URL(locationOf(res));
  return { url, state: url.searchParams.get("state")!, nonce: state.jar.get(SIGNIN_COOKIE)?.value ?? "" };
}
/** What GitHub does after the person authorizes: a code for `githubLogin` bound to the PKCE challenge, and the state. */
function callbackFor(b: { url: URL; state: string }, githubLogin: string, extra: Record<string, string> = {}, ip = IP, redirectUri = REDIRECT) {
  const code = fake.issueOAuthCode(githubLogin, { redirectUri, codeChallenge: b.url.searchParams.get("code_challenge") ?? undefined });
  return request(`/api/github/signin/callback?${new URLSearchParams({ code, state: b.state, ...extra }).toString()}`, { headers: withIp(ip) });
}
/** The whole round trip for a GitHub account; returns the callback's answer. */
async function signInWith(login: string, ip = IP, next?: string) {
  const b = await begin(next, ip);
  return signinCallback(callbackFor(b, login, {}, ip));
}
const failureOf = (res: Response) => new URL(locationOf(res), ORIGIN).searchParams.get("error");
const sessionOf = () => findSession(db(), state.jar.get(SESSION_COOKIE)?.value);
const tokenRow = (userId: string) => db().githubUserToken.findUnique({ where: { userId } });
const gh = (login: string, emails: Parameters<FakeGitHubServer["setEmails"]>[1] = []) => {
  const u = fake.users.get(login) ?? fake.addUser(login);
  fake.setEmails(login, emails);
  return u;
};
const verified = (email: string) => [{ email, primary: true, verified: true }];
const emailCalls = () => fake.calls.filter((c) => c.includes("/user/emails")).length;

// ---------- start ----------

describe("starting the sign-in", () => {
  it("sends the browser to GitHub with a single-use state, PKCE S256 and no secret, and keeps only hashes", async () => {
    const b = await begin("/settings");
    expect(b.url.origin + b.url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(b.url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(b.url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(b.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(b.url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(b.nonce).digest("base64url"));
    expect(b.url.toString()).not.toContain(CLIENT_SECRET);
    const rows = await db().githubSigninState.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usedAt: null, next: "/settings" });
    expect(rows[0].stateHash).toBe(createHash("sha256").update(b.state).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(b.state);
    expect(JSON.stringify(rows)).not.toContain(b.nonce);
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it("the nonce is a short-lived HttpOnly SameSite=Lax cookie that is only sent to the sign-in callback path", async () => {
    await begin();
    expect(state.jar.get(SIGNIN_COOKIE)!.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: SIGNIN_COOKIE_PATH, maxAge: 600 });
    expect(SIGNIN_COOKIE_PATH).toBe("/api/github/signin");
  });

  it("a hostile next is stored as a safe path", async () => {
    await begin("https://evil.example/x");
    expect((await db().githubSigninState.findFirstOrThrow()).next).toBe("/");
  });

  it("does not exist when the App is not configured, when the key is missing, or when this is not a hosted server", async () => {
    for (const name of ["MERGEPORT_GITHUB_APP_ID", "MERGEPORT_GITHUB_APP_PRIVATE_KEY", "MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "MERGEPORT_GITHUB_APP_CLIENT_ID", "MERGEPORT_GITHUB_APP_CLIENT_SECRET", "MERGEPORT_GITHUB_APP_SLUG"]) vi.stubEnv(name, "");
    resetGithubAppConfigCache();
    expect((await signinStart(request("/api/github/signin/start", { headers: withIp() }))).status).toBe(404);
    expect((await signinCallback(request("/api/github/signin/callback?code=x&state=y", { headers: withIp() }))).status).toBe(404);
    configure();
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    expect((await signinStart(request("/api/github/signin/start", { headers: withIp() }))).status).toBe(404);
    configure();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await signinStart(request("/api/github/signin/start", { headers: withIp() }))).status).toBe(404);
    expect(await db().githubSigninState.count()).toBe(0);
  });

  it("is refused without a trusted client address (nothing to rate-limit on)", async () => {
    const res = await signinStart(request("/api/github/signin/start"));
    expect(res.status).toBe(503);
    expect(await db().githubSigninState.count()).toBe(0);
  });
});

// ---------- rule 1: a linked GitHub id signs that person in ----------

describe("a GitHub account already linked to a person signs that person in", () => {
  it("opens a session for that person, ignores the address, keeps the token encrypted and audits it", async () => {
    const w = await workspaceWithOwner(db());
    const u = gh("octo"); // no email on GitHub at all
    await db().user.update({ where: { id: w.owner.id }, data: { githubId: BigInt(u.id), githubLogin: "old-name" } });
    await db().identity.create({ data: { userId: w.owner.id, provider: "github", subject: String(u.id) } });
    const res = await signInWith("octo");
    expect(res.status).toBe(303);
    expect(pathOf(res)).toBe("/");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await sessionOf())?.userId).toBe(w.owner.id);
    expect(emailCalls()).toBe(0); // the address is never consulted for a known id
    const row = await tokenRow(w.owner.id);
    expect(row?.status).toBe("OK");
    expect(row?.accessEnc).not.toContain("ghu_");
    expect(decryptSecret(row!.accessEnc!, key(), tokenAad(w.owner.id))).toMatch(/^ghu_/);
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubLogin).toBe("octo"); // refreshed from GitHub
    const log = await db().auditLog.findFirst({ where: { workspaceId: w.ws.id, action: "github.signin" } });
    expect(log).toMatchObject({ actorUserId: w.owner.id, targetId: w.owner.id });
    expect(await db().user.count()).toBe(1);
  });

  it("works for a legacy person whose githubId is set but who has no github identity row, and repairs the row", async () => {
    const u = gh("legacy");
    const legacy = await db().user.create({ data: { login: "legacy", githubId: BigInt(u.id) } });
    const res = await signInWith("legacy");
    expect(pathOf(res)).toBe("/onboarding");
    expect((await sessionOf())?.userId).toBe(legacy.id);
    expect(await db().identity.count({ where: { userId: legacy.id, provider: "github", subject: String(u.id) } })).toBe(1);
  });

  it("renews a link that had gone to RELINK", async () => {
    const w = await workspaceWithOwner(db());
    const u = gh("octo");
    await db().user.update({ where: { id: w.owner.id }, data: { githubId: BigInt(u.id) } });
    await db().githubUserToken.create({ data: { userId: w.owner.id, status: "RELINK" } });
    await signInWith("octo");
    expect((await tokenRow(w.owner.id))?.status).toBe("OK");
  });

  it("the account is matched by the numeric id, never by the login: a name another person's record carries means nothing", async () => {
    const victim = await workspaceWithOwner(db(), "victim@acme.test");
    await db().user.update({ where: { id: victim.owner.id }, data: { githubId: 424242n, githubLogin: "newguy", login: "newguy" } });
    await db().identity.create({ data: { userId: victim.owner.id, provider: "github", subject: "424242" } });
    gh("newguy", verified("newguy@fresh.test")); // a different account that now owns the name
    const res = await signInWith("newguy");
    const s = await sessionOf();
    expect(s?.userId).not.toBe(victim.owner.id);
    expect(pathOf(res)).toBe("/onboarding");
    const created = await db().user.findUniqueOrThrow({ where: { id: s!.userId } });
    expect(created.email).toBe("newguy@fresh.test");
    expect(await db().user.findUniqueOrThrow({ where: { id: victim.owner.id } })).toMatchObject({ githubId: 424242n });
  });
});

// ---------- rule 2: a new person with a verified primary address ----------

describe("an unknown GitHub account with a verified primary address and no account here creates a person", () => {
  it("creates the person (address verified, like a magic link), links the id, stores the token and signs them in", async () => {
    const u = gh("newbie", [{ email: "Side@Example.com", verified: true }, { email: "New.Bie@Example.com", primary: true, verified: true }]);
    const res = await signInWith("newbie");
    expect(pathOf(res)).toBe("/onboarding");
    const s = await sessionOf();
    const user = await db().user.findUniqueOrThrow({ where: { id: s!.userId }, include: { identities: true } });
    expect(user).toMatchObject({ email: "new.bie@example.com", githubId: BigInt(u.id), githubLogin: "newbie" });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.identities.map((i) => `${i.provider}:${i.subject}`).sort()).toEqual([`email:new.bie@example.com`, `github:${u.id}`]);
    expect((await tokenRow(user.id))?.status).toBe("OK");
    // The same person later arriving by email link is this person, not a second account.
    expect(await db().$transaction((tx) => userForVerifiedEmail(tx, "new.bie@example.com", new Date()))).toBe(user.id);
    // A second GitHub sign-in finds them by id, without asking for the address again.
    const before = emailCalls();
    state.jar.clear();
    await signInWith("newbie");
    expect((await sessionOf())?.userId).toBe(user.id);
    expect(emailCalls()).toBe(before);
    expect(await db().user.count()).toBe(1);
  });

  it("a pending invitation to that address is waiting for them and can be accepted", async () => {
    const w = await workspaceWithOwner(db(), "boss@acme.test", "Acme");
    await createInvitation(db(), w.viewer, { email: "invitee@example.com", role: "MEMBER", mailer: new RecordingMailer(), origin: ORIGIN });
    gh("invitee", verified("invitee@example.com"));
    const res = await signInWith("invitee");
    expect(pathOf(res)).toBe("/onboarding");
    const user = await db().user.findUniqueOrThrow({ where: { id: (await sessionOf())!.userId } });
    const pending = await pendingInvitationsFor(db(), { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt });
    expect(pending.map((p) => p.workspaceName)).toEqual(["Acme"]);
    const joined = await acceptInvitationById(db(), pending[0].id, { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt });
    expect(joined).toMatchObject({ ok: true });
    expect((await loadViewer(db(), user.id, w.ws.id))?.role).toBe("MEMBER");
  });

  it("an invitation link as the destination survives the sign-in", async () => {
    gh("invitee", verified("invitee@example.com"));
    const dest = `/invite/${"a".repeat(32)}`;
    expect(pathOf(await signInWith("invitee", IP, dest))).toBe(dest);
  });

  it("two first sign-ins of the same account at once make one person", async () => {
    gh("twin", verified("twin@example.com"));
    const a = await begin();
    const b = await begin();
    const [ra, rb] = await Promise.all([signinCallback(callbackFor(a, "twin")), signinCallback(callbackFor(b, "twin"))]);
    expect([pathOf(ra), pathOf(rb)].every((p) => p === "/onboarding" || p.startsWith("/sign-in"))).toBe(true);
    expect(await db().user.count()).toBe(1);
    expect(await db().identity.count({ where: { provider: "github" } })).toBe(1);
  });
});

// ---------- rule 3: the address belongs to an existing account ----------

describe("an unknown GitHub account whose verified address an account here already holds is refused", () => {
  it("links nothing, signs nobody in, revokes the token, tells the person what to do and audits it for the holder's workspaces", async () => {
    const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
    gh("attacker", verified("owner@acme.test"));
    const res = await signInWith("attacker");
    expect(res.status).toBe(303);
    expect(pathOf(res)).toBe("/sign-in?error=github-email-taken");
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await db().session.count()).toBe(0);
    expect(await db().user.count()).toBe(1);
    expect(await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).toMatchObject({ githubId: null, githubLogin: null });
    expect(await db().identity.count({ where: { provider: "github" } })).toBe(0);
    expect(await db().githubUserToken.count()).toBe(0);
    expect(fake.revokedUserTokens).toHaveLength(1); // nothing is kept at GitHub's side either
    const log = await db().auditLog.findFirstOrThrow({ where: { workspaceId: w.ws.id, action: "github.signin_refused" } });
    expect(log.meta).toMatchObject({ reason: "email-taken" });
    expect(JSON.stringify(log.meta)).not.toContain("owner@acme.test");
    const page = renderToStaticMarkup(AccountSignIn({ error: "github-email-taken" }));
    expect(page).toMatch(/Sign in with your email first/);
    expect(page).toMatch(/link GitHub from Settings/);
  });

  it("holds even when the account's address was never verified, when only an email identity holds it, and for a differently cased address", async () => {
    await db().user.create({ data: { login: "typed", email: "typed@example.com" } }); // typed in, never verified
    const viaIdentity = await db().user.create({ data: { login: "ident" } });
    await db().identity.create({ data: { userId: viaIdentity.id, provider: "email", subject: "ident@example.com", email: "ident@example.com" } });
    await person(db(), "mixed@example.com");
    gh("a1", verified("typed@example.com"));
    gh("a2", verified("ident@example.com"));
    gh("a3", verified("MIXED@Example.com"));
    for (const login of ["a1", "a2", "a3"]) {
      state.jar.clear();
      expect(failureOf(await signInWith(login))).toBe("github-email-taken");
      expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    }
    expect(await db().user.count()).toBe(3);
    expect(await db().identity.count({ where: { provider: "github" } })).toBe(0);
  });

  it("the person can then sign in by email and link GitHub from Settings (the link flow is unchanged)", async () => {
    const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
    gh("owner-gh", verified("owner@acme.test"));
    expect(failureOf(await signInWith("owner-gh"))).toBe("github-email-taken");
    // Linking is the signed-in person's own act, covered in github-link.test.ts: the refusal left them free to do it.
    expect(await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).toMatchObject({ githubId: null });
  });
});

// ---------- rule 4 and 5: no address to trust ----------

describe("no verified primary address means no sign-in", () => {
  it("an unverified primary, a verified non-primary, no addresses and a malformed address are all refused and write nothing", async () => {
    gh("u1", [{ email: "u1@example.com", primary: true, verified: false }]);
    gh("u2", [{ email: "u2@example.com", primary: false, verified: true }]);
    gh("u3", []);
    gh("u4", [{ email: "not an address", primary: true, verified: true }]);
    for (const login of ["u1", "u2", "u3", "u4"]) {
      state.jar.clear();
      expect(failureOf(await signInWith(login))).toBe("github-no-email");
      expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    }
    expect(await db().user.count()).toBe(0);
    expect(await db().githubUserToken.count()).toBe(0);
    expect(fake.revokedUserTokens).toHaveLength(4);
    expect(renderToStaticMarkup(AccountSignIn({ error: "github-no-email" }))).toMatch(/no verified primary email/);
  });

  it("an App registered without the email permission is a server problem, not the person's", async () => {
    gh("octo", verified("octo@example.com"));
    fake.forbidEmails = true;
    expect(failureOf(await signInWith("octo"))).toBe("github-app-problem");
    expect(await db().user.count()).toBe(0);
    expect(fake.revokedUserTokens).toHaveLength(1);
  });
});

// ---------- removed members ----------

describe("people who were removed from a workspace are handled like every other sign-in method", () => {
  it("a person removed from their only workspace signs in and lands on onboarding, with no access to it", async () => {
    const w = await workspaceWithOwner(db(), "boss@acme.test", "Acme");
    const m = await addMember(db(), w.ws.id, "gone@acme.test", "MEMBER");
    const u = gh("gone");
    await db().user.update({ where: { id: m.user.id }, data: { githubId: BigInt(u.id) } });
    await db().member.update({ where: { id: m.member.id }, data: { status: "REVOKED" } });
    const res = await signInWith("gone");
    expect(pathOf(res)).toBe("/onboarding");
    expect((await sessionOf())?.userId).toBe(m.user.id);
    expect(await loadViewer(db(), m.user.id, w.ws.id)).toBeNull();
    expect(await db().auditLog.count({ where: { workspaceId: w.ws.id, action: "github.signin" } })).toBe(0); // only workspaces they are still in see it
  });
});

// ---------- state, nonce, replay ----------

describe("state and nonce", () => {
  it("a state works once: replaying the same callback signs nobody in again", async () => {
    gh("octo", verified("octo@example.com"));
    const b = await begin();
    const req = () => callbackFor(b, "octo");
    expect(pathOf(await signinCallback(req()))).toBe("/onboarding");
    state.jar.clear();
    state.jar.set(SIGNIN_COOKIE, { value: b.nonce, options: {} }); // an attacker who also holds the cookie
    const replay = await signinCallback(req());
    expect(failureOf(replay)).toBe("github-invalid");
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await db().session.count()).toBe(1);
  });

  it("a callback from another browser (no nonce cookie, or someone else's) is refused, and the state is spent", async () => {
    gh("octo", verified("octo@example.com"));
    const b = await begin();
    state.jar.delete(SIGNIN_COOKIE);
    expect(failureOf(await signinCallback(callbackFor(b, "octo")))).toBe("github-invalid");
    expect(await db().user.count()).toBe(0);
    expect(fake.oauthExchanges).toHaveLength(0); // never reached GitHub

    const b2 = await begin();
    state.jar.set(SIGNIN_COOKIE, { value: "x".repeat(43), options: {} });
    expect(failureOf(await signinCallback(callbackFor(b2, "octo")))).toBe("github-invalid");
    expect(await db().user.count()).toBe(0);
  });

  it("a state that was never issued, a tampered one, an expired one and a malformed one are refused", async () => {
    gh("octo", verified("octo@example.com"));
    const b = await begin();
    const bad = [`signin.${"A".repeat(43)}`, `${b.state}x`, "nonsense", `other.${b.state.split(".")[1]}`, ""];
    for (const s of bad) {
      const res = await signinCallback(callbackFor({ url: b.url, state: s }, "octo"));
      expect(failureOf(res)).toBe("github-invalid");
    }
    expect(state.jar.has(SIGNIN_COOKIE)).toBe(true); // a forged GET did not spend this browser's nonce
    await db().githubSigninState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(failureOf(await signinCallback(callbackFor(b, "octo")))).toBe("github-invalid");
    expect(await db().user.count()).toBe(0);
  });

  it("the code must belong to this flow: a code issued for another PKCE challenge or redirect is refused", async () => {
    gh("octo", verified("octo@example.com"));
    const a = await begin();
    const other = await begin();
    state.jar.set(SIGNIN_COOKIE, { value: a.nonce, options: {} }); // this browser's flow is `a`; the code was issued for the challenge of `other`
    expect(failureOf(await signinCallback(callbackFor({ url: other.url, state: a.state }, "octo")))).toBe("github-declined");
    const c = await begin();
    expect(failureOf(await signinCallback(callbackFor(c, "octo", {}, IP, `${ORIGIN}/elsewhere`)))).toBe("github-declined");
    expect(await db().user.count()).toBe(0);
  });

  it("a person who cancels on GitHub (no code) or a GitHub outage ends in a fixed message and nothing is written", async () => {
    gh("octo", verified("octo@example.com"));
    const b = await begin();
    const res = await signinCallback(request(`/api/github/signin/callback?${new URLSearchParams({ state: b.state, error: "access_denied", error_description: "<script>" })}`, { headers: withIp() }));
    expect(failureOf(res)).toBe("github-declined");
    expect(locationOf(res)).not.toContain("script");
    fake.offline = true;
    const c = await begin();
    expect(failureOf(await signinCallback(callbackFor(c, "octo")))).toBe("github-unavailable");
    fake.offline = false;
    expect(await db().user.count()).toBe(0);
  });

  it("no token, code or secret reaches the log", async () => {
    gh("octo", verified("octo@example.com"));
    const b = await begin();
    const req = callbackFor(b, "octo");
    const code = new URL(req.url).searchParams.get("code")!;
    await signinCallback(req);
    const all = logs.join("\n");
    for (const s of [code, b.nonce, CLIENT_SECRET, "ghu_", "ghr_"]) expect(all).not.toContain(s);
  });
});

// ---------- rate limits ----------

describe("rate limits are per client address", () => {
  it("the 21st start from one address in ten minutes is refused, another address is not affected", async () => {
    for (let i = 0; i < 20; i++) expect((await signinStart(request("/api/github/signin/start", { headers: withIp() }))).status).toBe(302);
    const res = await signinStart(request("/api/github/signin/start", { headers: withIp() }));
    expect(failureOf(res)).toBe("github-rate-limited");
    expect((await signinStart(request("/api/github/signin/start", { headers: withIp("198.51.100.9") }))).status).toBe(302);
    expect(await db().githubSigninState.count()).toBe(21);
  });

  it("callbacks are limited per address too, and a malformed callback costs nothing", async () => {
    for (let i = 0; i < 30; i++) await signinCallback(request("/api/github/signin/callback?state=garbage", { headers: withIp() }));
    const b = await begin();
    gh("octo", verified("octo@example.com"));
    expect(pathOf(await signinCallback(callbackFor(b, "octo")))).toBe("/onboarding"); // still fine: garbage was free
    const key = `auth:ghsi:cb:${createHash("sha256").update(IP).digest("hex")}`;
    await db().rateLimitState.update({ where: { key }, data: { remaining: 0 } });
    const c = await begin();
    expect(failureOf(await signinCallback(callbackFor(c, "octo")))).toBe("github-rate-limited");
    expect(fake.oauthExchanges).toHaveLength(1);
  });

  it("the client address comes from the trusted proxy entry, not from what the client claimed", async () => {
    vi.stubEnv("MERGEPORT_TRUSTED_PROXY_HOPS", "1");
    for (let i = 0; i < 20; i++) await signinStart(request("/api/github/signin/start", { headers: { "x-forwarded-for": `10.9.9.${i}, ${IP}` } }));
    expect(failureOf(await signinStart(request("/api/github/signin/start", { headers: { "x-forwarded-for": `10.1.1.1, ${IP}` } })))).toBe("github-rate-limited");
  });
});

// ---------- the sign-in page ----------

describe("the sign-in page", () => {
  const html = (p: Parameters<typeof AccountSignIn>[0] = {}) => renderToStaticMarkup(AccountSignIn(p));

  it("shows Continue with GitHub only when the deployment's App is set up", () => {
    expect(githubSignInEnabled()).toBe(true);
    expect(html()).toContain("Continue with GitHub");
    expect(html({ next: "/settings" })).toContain("/api/github/signin/start?next=%2Fsettings");
  });

  it("hides it when the App is not configured, partly configured, the key is missing or it is not hosted", () => {
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    expect(githubSignInEnabled()).toBe(false);
    expect(html()).not.toContain("Continue with GitHub");
    configure();
    for (const name of ["MERGEPORT_GITHUB_APP_ID", "MERGEPORT_GITHUB_APP_PRIVATE_KEY", "MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "MERGEPORT_GITHUB_APP_CLIENT_ID", "MERGEPORT_GITHUB_APP_CLIENT_SECRET", "MERGEPORT_GITHUB_APP_SLUG"]) vi.stubEnv(name, "");
    resetGithubAppConfigCache();
    expect(githubAppConfig()).toBeNull();
    expect(githubSignInEnabled()).toBe(false);
    expect(html()).not.toContain("Continue with GitHub");
    expect(html()).not.toContain("/api/github/signin");
    configure();
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", "");
    resetGithubAppConfigCache();
    expect(html()).not.toContain("Continue with GitHub");
    configure();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect(githubSignInEnabled()).toBe(false);
  });

  it("every failure code has its own message", () => {
    for (const r of SIGNIN_FAILURES.filter((r) => r !== "email-taken")) {
      const out = html({ error: `github-${r}` });
      expect(out, r).toContain("Could not sign you in");
      expect(out, r).not.toContain("Something went wrong. Try again.</"); // the generic fallback
    }
  });
});

// ---------- perimeter ----------

describe("proxy.ts", () => {
  it("the callback is a normal browser GET and passes; the Origin rule for other methods is unchanged", () => {
    const get = proxy(new NextRequest(`${ORIGIN}/api/github/signin/callback?code=x&state=y`, { headers: { host: HOST } }));
    expect(get.status).not.toBe(403);
    const post = (origin: string | null) => proxy(new NextRequest(`${ORIGIN}/api/github/signin/callback`, { method: "POST", headers: { host: HOST, ...(origin ? { origin } : {}) } }));
    expect(post("https://evil.example").status).toBe(403);
    expect(post(null).status).toBe(403);
    expect(proxy(new NextRequest(`${ORIGIN}/api/github/signin/callback`, { method: "POST", headers: { host: "evil.example" } })).status).toBe(403);
  });
});

// ---------- the library entry point ----------

describe("completeSignIn", () => {
  it("answers with fixed codes only", async () => {
    const r = await completeSignIn(db(), { state: "nope", code: "c", nonce: "n", ip: IP, config: githubAppConfig()!, redirectUri: REDIRECT });
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });
});
