import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, locationOf, request, state } from "./auth-mocks";
import { addMember, person, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/federation/config";
import { GithubAppError } from "@/lib/github/app-auth";
import { githubAppConfig, resetGithubAppConfigCache } from "@/lib/github/app-config";
import { setConnectOverridesForTests } from "@/lib/github/connect";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { ACCESS_JOB, accessJobKey } from "@/lib/github/access-cache";
import { LINK_COOKIE, LINK_COOKIE_PATH, completeLink, linkGithubAccount, startLink, unlinkGithubAccount } from "@/lib/github/user-link";
import { getUserAccessToken, markRelink, tokenAad } from "@/lib/github/user-token";
import { proxy } from "@/proxy";

vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: m.HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

import { GET as linkCallback } from "@/app/api/github/link/callback/route";
import { checkGithubAccessAction, startGithubLinkAction, unlinkGithubAction } from "@/app/github-link-actions";

const CLIENT_ID = "Iv1.testclient01";
const CLIENT_SECRET = "client-secret-0123456789-abcdef";
const ENC_KEY = "k".repeat(40);
const REDIRECT = `${ORIGIN}/api/github/link/callback`;

let fake: FakeGitHubServer;
let app: ReturnType<FakeGitHubServer["registerApp"]>;
let n = 0;
let logs: string[];
let spies: ReturnType<typeof vi.spyOn>[];

function configure() {
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
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
  state.db = createTestPrisma(`github-link-${n++}`);
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
const cfg = () => githubAppConfig()!;
const key = () => Buffer.from(createHash("sha256").update(Buffer.from(ENC_KEY, "utf8")).digest());

// ---------- helpers ----------

const fd = () => new FormData();
async function signIn(userId: string, workspaceId: string) {
  const { token } = await createSession(db(), userId, new Date(), workspaceId);
  state.jar.set(SESSION_COOKIE, { value: token, options: {} });
}
const resultOf = (res: Response) => new URL(locationOf(res)).searchParams.get("githublink");

/** A workspace whose owner is signed in, plus the GitHub account `login` on the fake. */
async function world(login = "octo") {
  const w = await workspaceWithOwner(db());
  if (!fake.users.has(login)) fake.addUser(login);
  await signIn(w.owner.id, w.ws.id);
  return w;
}

/** Presses "Link GitHub": the address the browser would be sent to and the nonce it keeps. */
async function begin() {
  const r = await startGithubLinkAction(fd());
  if (!r.ok) throw new Error(`start refused: ${r.error}`);
  const url = new URL(String(r.data?.redirect));
  return { url, state: url.searchParams.get("state")!, nonce: state.jar.get(LINK_COOKIE)?.value ?? "" };
}
/** What GitHub does after the person authorizes: a code for `githubLogin` bound to the PKCE challenge, and the state. */
function authorized(b: { url: URL; state: string }, githubLogin: string, extra: Record<string, string> = {}, redirectUri = REDIRECT) {
  const code = fake.issueOAuthCode(githubLogin, { redirectUri, codeChallenge: b.url.searchParams.get("code_challenge") ?? undefined });
  return request(`/api/github/link/callback?${new URLSearchParams({ code, state: b.state, ...extra }).toString()}`);
}
async function linkAs(userId: string, workspaceId: string, login: string) {
  await signIn(userId, workspaceId);
  const b = await begin();
  const res = await linkCallback(authorized(b, login));
  return resultOf(res);
}
const tokenRow = (userId: string) => db().githubUserToken.findUnique({ where: { userId } });
const noLeak = (secrets: string[]) => {
  const all = logs.join("\n");
  for (const s of secrets) expect(all).not.toContain(s);
};

// ---------- start ----------

describe("starting the link", () => {
  it("sends the person to GitHub's authorize page with a single-use state, PKCE S256 and no secret, and keeps only hashes", async () => {
    const w = await world();
    const b = await begin();
    expect(b.url.origin + b.url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(b.url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(b.url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(b.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(b.url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(b.nonce).digest("base64url"));
    expect(b.url.toString()).not.toContain(CLIENT_SECRET);
    expect(b.state.startsWith(`${w.ws.id}.`)).toBe(true);
    const rows = await db().githubAppState.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: w.ws.id, userId: w.owner.id, kind: "link", usedAt: null });
    expect(rows[0].stateHash).toBe(createHash("sha256").update(b.state).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(b.state);
    expect(JSON.stringify(rows)).not.toContain(b.nonce);
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it("the nonce is a short-lived HttpOnly SameSite=Lax cookie that is only sent to the link callback path", async () => {
    await world();
    await begin();
    expect(state.jar.get(LINK_COOKIE)!.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: LINK_COOKIE_PATH, maxAge: 600 });
    expect(LINK_COOKIE_PATH).toBe("/api/github/link");
  });

  it("any role may link their own account, a reader included", async () => {
    const w = await world();
    const reader = await addMember(db(), w.ws.id, "reader@acme.test", "READER");
    await signIn(reader.user.id, w.ws.id);
    const r = await startGithubLinkAction(fd());
    expect(r.ok).toBe(true);
  });

  it("is refused without a session, when this is not a hosted server, when the App is not set up and when the encryption key is missing", async () => {
    await world();
    state.jar.delete(SESSION_COOKIE);
    await expect(startGithubLinkAction(fd())).rejects.toThrow(); // redirect to sign-in
    const w2 = await world("octo2");
    await signIn(w2.owner.id, w2.ws.id);

    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    const noKey = await startGithubLinkAction(fd());
    expect(noKey).toMatchObject({ ok: false });
    expect(!noKey.ok && noKey.error).toMatch(/not available on this server yet/);
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "too short"); // a malformed key is no key
    expect((await startGithubLinkAction(fd())).ok).toBe(false);
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", ENC_KEY);

    vi.stubEnv("MERGEPORT_GITHUB_APP_ID", "");
    vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "");
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", "");
    vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "");
    resetGithubAppConfigCache();
    const noApp = await startGithubLinkAction(fd());
    expect(!noApp.ok && noApp.error).toMatch(/GitHub is not set up on this server/);
    configure();

    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const local = await startGithubLinkAction(fd());
    expect(!local.ok && local.error).toMatch(/hosted workspaces/);
    expect(await db().githubAppState.count()).toBe(0);
  });

  it("is refused while already linked and allowed again once the link needs renewing", async () => {
    const w = await world();
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    const again = await startGithubLinkAction(fd());
    expect(!again.ok && again.error).toMatch(/already linked/);
    await markRelink(db(), w.owner.id);
    expect((await startGithubLinkAction(fd())).ok).toBe(true);
  });

  it("is rate limited per person", async () => {
    const w = await world();
    let refused = 0;
    for (let i = 0; i < 12; i++) if (!(await startGithubLinkAction(fd())).ok) refused++;
    expect(refused).toBe(2);
    const other = await addMember(db(), w.ws.id, "other@acme.test", "MEMBER");
    await signIn(other.user.id, w.ws.id);
    expect((await startGithubLinkAction(fd())).ok).toBe(true); // another person's budget is their own
  });
});

// ---------- callback ----------

describe("completing the link", () => {
  it("links the account GitHub reports: githubId, githubLogin, a github identity, the encrypted token, an audit row and the first access check", async () => {
    const w = await world("octo");
    const b = await begin();
    const res = await linkCallback(authorized(b, "octo"));
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`${ORIGIN}/settings?githublink=linked#github-account`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const octo = fake.users.get("octo")!;
    const user = await db().user.findUniqueOrThrow({ where: { id: w.owner.id } });
    expect(user.githubId).toBe(BigInt(octo.id));
    expect(user.githubLogin).toBe("octo");
    const ident = await db().identity.findMany({ where: { userId: w.owner.id, provider: "github" } });
    expect(ident.map((i) => i.subject)).toEqual([String(octo.id)]);
    const audit = await db().auditLog.findMany({ where: { action: "github.link" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ workspaceId: w.ws.id, actorUserId: w.owner.id });
    const job = await db().job.findUnique({ where: { dedupeKey: accessJobKey(w.owner.id) } });
    expect(job).toMatchObject({ type: ACCESS_JOB, workspaceId: null, status: "QUEUED" });
    expect(job!.payload).toEqual({ userId: w.owner.id });
    expect(state.jar.has(LINK_COOKIE)).toBe(false); // the nonce is spent
    expect(fake.oauthExchanges.at(-1)).toMatchObject({ ok: true, redirectUri: REDIRECT });
    expect(fake.oauthExchanges.at(-1)!.verifier).toBe(b.nonce); // PKCE verifier = the browser nonce
  });

  it("stores the token only as AES-GCM ciphertext bound to the person: not plain, not readable under another person's id, usable with the right key", async () => {
    const w = await world("octo");
    await linkAs(w.owner.id, w.ws.id, "octo");
    const row = (await tokenRow(w.owner.id))!;
    expect(row.status).toBe("OK");
    expect(row.accessEnc).toMatch(/^v1\./);
    expect(row.refreshEnc).toMatch(/^v1\./);
    const plain = decryptSecret(row.accessEnc!, key(), tokenAad(w.owner.id))!;
    expect(plain).toMatch(/^ghu_/);
    expect(JSON.stringify(row)).not.toContain(plain);
    expect(decryptSecret(row.accessEnc!, key(), tokenAad("someone-else"))).toBeNull(); // AAD: a copied ciphertext does not open
    expect(decryptSecret(row.accessEnc!, Buffer.alloc(32, 7), tokenAad(w.owner.id))).toBeNull();
    // The lifetimes are GitHub's own, stored as dates (8 hours / about 6 months from the fake's answer).
    expect(row.accessExpiresAt!.getTime() - Date.now()).toBeGreaterThan(7.9 * 3600_000);
    expect(row.accessExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(8 * 3600_000);
    expect(row.refreshExpiresAt!.getTime() - Date.now()).toBeGreaterThan(100 * 86_400_000);
    const me = await fake.appFetch()("https://api.github.com/user", { headers: { authorization: `Bearer ${plain}` } });
    expect(me.status).toBe(200);
  });

  it("a state is single use: replaying the callback links nothing twice and says the link is no longer valid", async () => {
    const w = await world("octo");
    const b = await begin();
    const req = authorized(b, "octo");
    expect(resultOf(await linkCallback(req))).toBe("linked");
    state.jar.set(LINK_COOKIE, { value: b.nonce, options: {} }); // even with the browser still holding the nonce
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("invalid-link");
    expect(await db().githubUserToken.count()).toBe(1);
    expect(await db().auditLog.count({ where: { action: "github.link", workspaceId: w.ws.id } })).toBe(1);
  });

  it("an expired state, a state of another person, a wrong or missing nonce and a state of another kind are all refused and write nothing", async () => {
    const w = await world("octo");
    // expired
    let b = await begin();
    await db().githubAppState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("invalid-link");
    // another person's state
    const mallory = await addMember(db(), w.ws.id, "mallory@acme.test", "MEMBER");
    b = await begin();
    await signIn(mallory.user.id, w.ws.id);
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("invalid-link");
    // wrong nonce / missing nonce (a different browser)
    await signIn(w.owner.id, w.ws.id);
    b = await begin();
    state.jar.set(LINK_COOKIE, { value: "x".repeat(43), options: {} });
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("invalid-link");
    b = await begin();
    state.jar.delete(LINK_COOKIE);
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("invalid-link");
    // a state made for the connect flow (an administrator's workspace connection) is not a link
    const connectState = `${w.ws.id}.${"c".repeat(43)}`;
    const nonce = "n".repeat(43);
    await db().githubAppState.create({ data: { workspaceId: w.ws.id, userId: w.owner.id, kind: "connect-existing", stateHash: createHash("sha256").update(connectState).digest("hex"), nonceHash: createHash("sha256").update(`ghconnect-nonce:${nonce}`).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    state.jar.set(LINK_COOKIE, { value: nonce, options: {} });
    expect(resultOf(await linkCallback(authorized({ url: new URL("https://x/?code_challenge=" + createHash("sha256").update(nonce).digest("base64url")), state: connectState }, "octo")))).toBe("invalid-link");

    const user = await db().user.findUniqueOrThrow({ where: { id: w.owner.id } });
    expect(user.githubId).toBeNull();
    expect(await db().githubUserToken.count()).toBe(0);
    expect(await db().identity.count({ where: { provider: "github" } })).toBe(0);
  });

  it("a callback without a session does not consume the state; signing in and trying again works", async () => {
    const w = await world("octo");
    const b = await begin();
    const req = authorized(b, "octo");
    const sessionCookie = state.jar.get(SESSION_COOKIE)!;
    state.jar.delete(SESSION_COOKIE);
    const res = await linkCallback(req);
    expect(locationOf(res)).toMatch(/^https:\/\/app\.test\/sign-in\?next=%2Fsettings$/);
    expect((await db().githubAppState.findFirstOrThrow()).usedAt).toBeNull();
    expect(state.jar.has(LINK_COOKIE)).toBe(true);
    state.jar.set(SESSION_COOKIE, sessionCookie);
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("linked");
    expect(w.owner.id).toBeTruthy();
  });

  it("a malformed state costs nothing and keeps the person's flow in progress", async () => {
    await world("octo");
    const b = await begin();
    for (const bad of ["", "nodot", "a.b", "../../x", "x".repeat(400)]) {
      const res = await linkCallback(request(`/api/github/link/callback?code=abc&state=${encodeURIComponent(bad)}`));
      expect(resultOf(res)).toBe("invalid-link");
    }
    expect(state.jar.has(LINK_COOKIE)).toBe(true);
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("linked");
    expect(await db().rateLimitState.count({ where: { key: { startsWith: "ghlink:cb:" } } })).toBe(1); // only the real attempt was counted
  });

  it("declining on GitHub, a PKCE mismatch and a wrong redirect address link nothing", async () => {
    const w = await world("octo");
    let b = await begin();
    expect(resultOf(await linkCallback(request(`/api/github/link/callback?state=${encodeURIComponent(b.state)}`)))).toBe("cannot-verify"); // no code: declined
    b = await begin();
    const wrongChallenge = authorized({ url: new URL("https://x/?code_challenge=" + createHash("sha256").update("another-verifier").digest("base64url")), state: b.state }, "octo");
    expect(resultOf(await linkCallback(wrongChallenge))).toBe("cannot-verify");
    b = await begin();
    expect(resultOf(await linkCallback(authorized(b, "octo", {}, `${ORIGIN}/elsewhere`)))).toBe("cannot-verify");
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubId).toBeNull();
    expect(await db().githubUserToken.count()).toBe(0);
  });

  it("the answer is always a path on this site with one fixed code, whatever the query says", async () => {
    await world("octo");
    const b = await begin();
    const res = await linkCallback(authorized(b, "octo", { next: "https://evil.example/", redirect_uri: "https://evil.example/", githublink: "<script>", return_to: "//evil.example" }));
    const loc = locationOf(res);
    expect(loc).toBe(`${ORIGIN}/settings?githublink=linked#github-account`);
    expect(new URL(loc).origin).toBe(ORIGIN);
    // a signed-out callback also only ever goes to our own sign-in page
    state.jar.delete(SESSION_COOKIE);
    const out = await linkCallback(request("/api/github/link/callback?next=https://evil.example/"));
    expect(locationOf(out).startsWith(`${ORIGIN}/sign-in`)).toBe(true);
  });

  it("answers 404 where linking does not exist: not hosted, or the App not set up", async () => {
    await world("octo");
    const b = await begin();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await linkCallback(authorized(b, "octo"))).status).toBe(404);
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", "");
    resetGithubAppConfigCache();
    expect((await linkCallback(authorized(b, "octo"))).status).toBe(404);
  });

  it("the callback is rate limited per person, and GitHub being unreachable or the App being rejected are fixed codes", async () => {
    const w = await world("octo");
    let b = await begin();
    fake.offline = true;
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("unavailable");
    fake.offline = false;
    b = await begin();
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", "wrong-secret-0123456789-abcdef");
    resetGithubAppConfigCache();
    expect(resultOf(await linkCallback(authorized(b, "octo")))).toBe("cannot-verify");
    configure();
    const codes: (string | null)[] = [];
    for (let i = 0; i < 22; i++) codes.push(resultOf(await linkCallback(request(`/api/github/link/callback?code=c&state=${encodeURIComponent(`${w.ws.id}.${"z".repeat(30)}`)}`))));
    expect(codes.filter((c) => c === "rate-limited").length).toBeGreaterThan(0);
  });
});

// ---------- account takeover ----------

describe("account takeover is refused in both directions, and a refusal writes nothing", () => {
  it("a GitHub account already linked to a DIFFERENT person is refused, and the token the attempt got is revoked at GitHub", async () => {
    const w = await world("octo");
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    const mallory = await addMember(db(), w.ws.id, "mallory@acme.test", "MEMBER");
    const before = fake.revokedUserTokens.length;
    expect(await linkAs(mallory.user.id, w.ws.id, "octo")).toBe("github-taken");
    const m = await db().user.findUniqueOrThrow({ where: { id: mallory.user.id } });
    expect(m.githubId).toBeNull();
    expect(m.githubLogin).toBeNull();
    expect(await db().githubUserToken.findUnique({ where: { userId: mallory.user.id } })).toBeNull();
    expect(await db().identity.count({ where: { userId: mallory.user.id, provider: "github" } })).toBe(0);
    expect(await db().auditLog.count({ where: { action: "github.link", actorUserId: mallory.user.id } })).toBe(0);
    expect(fake.revokedUserTokens.length).toBe(before + 1); // the token of the refused attempt was ended
    // the rightful owner is untouched
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubLogin).toBe("octo");
    expect((await tokenRow(w.owner.id))!.status).toBe("OK");
  });

  it("a person who already has a DIFFERENT GitHub account linked must unlink first; accounts are never merged by email or name", async () => {
    const w = await world("octo");
    fake.addUser("octo-two");
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    // To get past the "already linked" check at the start, the link is marked as needing renewal (the only state in which Link GitHub is offered).
    await markRelink(db(), w.owner.id);
    expect(await linkAs(w.owner.id, w.ws.id, "octo-two")).toBe("other-account");
    const u = await db().user.findUniqueOrThrow({ where: { id: w.owner.id } });
    expect(u.githubLogin).toBeNull(); // the login is cleared when the link needs renewing (F5); the numeric id and identity stay
    expect(u.githubId).toBe(BigInt(fake.users.get("octo")!.id));
    expect(await db().identity.count({ where: { userId: w.owner.id, provider: "github" } })).toBe(1);
    // after unlinking, the other account can be linked
    await unlinkGithubAccount(db(), { userId: w.owner.id, workspaceId: w.ws.id }, cfg());
    expect(await linkAs(w.owner.id, w.ws.id, "octo-two")).toBe("linked");
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubLogin).toBe("octo-two");
  });

  it("a person whose email or sign-in name equals a GitHub login does not inherit that account: only GitHub's own answer links", async () => {
    const w = await world("alice");
    const alice = await person(db(), "alice@elsewhere.test"); // login "alice", signed in by email
    await db().member.create({ data: { workspaceId: w.ws.id, userId: alice.id, role: "MEMBER", status: "ACTIVE" } });
    expect(alice.login).toBe("alice");
    expect(alice.githubId).toBeNull();
    expect(await linkAs(w.owner.id, w.ws.id, "alice")).toBe("linked"); // the owner proves they control GitHub's "alice"
    expect((await db().user.findUniqueOrThrow({ where: { id: alice.id } })).githubId).toBeNull();
    expect(await linkAs(alice.id, w.ws.id, "alice")).toBe("github-taken");
  });

  it("two people linking the same GitHub account at once: exactly one wins, the other is refused, one identity exists", async () => {
    const w = await world("octo");
    const b = await addMember(db(), w.ws.id, "b@acme.test", "MEMBER");
    const gh = { id: BigInt(fake.users.get("octo")!.id), login: "octo" };
    const tokens = { accessToken: "ghu_a", refreshToken: "ghr_a", expiresInSeconds: 28800, refreshExpiresInSeconds: 15_000_000 };
    for (let round = 0; round < 3; round++) {
      await db().githubUserToken.deleteMany({});
      await db().identity.deleteMany({ where: { provider: "github" } });
      await db().user.updateMany({ data: { githubId: null, githubLogin: null } });
      const results = await Promise.all([w.owner.id, b.user.id].map((userId) => linkGithubAccount(db(), { userId, workspaceId: w.ws.id, github: gh, tokens, key: key(), now: new Date() })));
      expect([...results].sort()).toEqual(["github-taken", "linked"]);
      expect(await db().identity.count({ where: { provider: "github" } })).toBe(1);
      expect(await db().user.count({ where: { githubId: gh.id } })).toBe(1);
      expect(await db().githubUserToken.count()).toBe(1);
      expect(await db().auditLog.count({ where: { action: "github.link" } })).toBe(round + 1);
    }
  });

  it("linking the same account again (a renewal) keeps one identity and replaces the token", async () => {
    const w = await world("octo");
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    const first = (await tokenRow(w.owner.id))!;
    await markRelink(db(), w.owner.id);
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    const second = (await tokenRow(w.owner.id))!;
    expect(second.status).toBe("OK");
    expect(second.accessEnc).not.toBe(first.accessEnc);
    expect(await db().identity.count({ where: { userId: w.owner.id, provider: "github" } })).toBe(1);
  });
});

// ---------- token lifetime ----------

describe("the stored token: renewal, rotation, single flight, relinking", () => {
  const deps = () => ({ fetch: fake.appFetch() });
  async function linked(login = "octo") {
    const w = await world(login);
    expect(await linkAs(w.owner.id, w.ws.id, login)).toBe("linked");
    return w;
  }
  const plainOf = async (userId: string) => decryptSecret((await tokenRow(userId))!.accessEnc!, key(), tokenAad(userId))!;

  it("a token that is still good is used as it is; nothing is asked of GitHub", async () => {
    const w = await linked();
    const calls = fake.calls.length;
    const t = await getUserAccessToken(db(), cfg(), w.owner.id, deps());
    expect(t).toMatchObject({ kind: "ok", token: await plainOf(w.owner.id) });
    expect(fake.calls.length).toBe(calls);
    expect(fake.refreshExchanges.ok).toBe(0);
  });

  it("an expired token is renewed and the new refresh token REPLACES the old one in one update (the old one stops working)", async () => {
    const w = await linked();
    const before = (await tokenRow(w.owner.id))!;
    const oldRefresh = decryptSecret(before.refreshEnc!, key(), tokenAad(w.owner.id))!;
    const oldAccess = await plainOf(w.owner.id);
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const t = await getUserAccessToken(db(), cfg(), w.owner.id, deps());
    expect(t.kind).toBe("ok");
    const after = (await tokenRow(w.owner.id))!;
    const newRefresh = decryptSecret(after.refreshEnc!, key(), tokenAad(w.owner.id))!;
    expect(newRefresh).not.toBe(oldRefresh);
    expect(t.kind === "ok" && t.token).toBe(await plainOf(w.owner.id));
    expect(t.kind === "ok" && t.token).not.toBe(oldAccess);
    expect(after.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 3600_000);
    expect(fake.refreshExchanges).toEqual({ ok: 1, refused: 0 });
    // the old refresh token is dead at GitHub: spending it again is refused
    const again = await fake.appFetch()("https://github.com/login/oauth/access_token", { method: "POST", body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: oldRefresh }) });
    expect((await again.json()).error).toBe("bad_refresh_token");
    noLeak([oldRefresh, newRefresh, oldAccess]);
  });

  it("renewal is single flight: concurrent callers (also two 'processes') spend the refresh token once", async () => {
    const w = await linked();
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const results = await Promise.all(Array.from({ length: 6 }, () => getUserAccessToken(db(), cfg(), w.owner.id, deps())));
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    expect(new Set(results.map((r) => (r.kind === "ok" ? r.token : ""))).size).toBe(1);
    expect(fake.refreshExchanges).toEqual({ ok: 1, refused: 0 });
  });

  it("two database sessions renewing at once (row lock): the second waits and uses the first one's token", async () => {
    const w = await linked();
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    // Same promise cache would hide the lock, so the second caller asks for the other cache key: a forced renewal is a different flight but must still not double-spend.
    const [a, b] = await Promise.all([getUserAccessToken(db(), cfg(), w.owner.id, deps()), getUserAccessToken(db(), cfg(), w.owner.id, deps())]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(fake.refreshExchanges.ok).toBe(1);
  });

  it("a refresh token GitHub refuses marks the link as needing relinking, clears the token and the cached access, and nothing tries again", async () => {
    const w = await linked();
    await db().githubRepoAccess.create({ data: { userId: w.owner.id, repositoryGithubId: 1n, installationId: 9n, permission: "pull", checkedAt: new Date() } });
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    fake.invalidateRefreshTokens("octo");
    expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "relink" });
    const row = (await tokenRow(w.owner.id))!;
    expect(row).toMatchObject({ status: "RELINK", accessEnc: null, refreshEnc: null, accessExpiresAt: null, refreshExpiresAt: null });
    expect(await db().githubRepoAccess.count({ where: { userId: w.owner.id } })).toBe(0);
    const calls = fake.calls.length;
    for (let i = 0; i < 3; i++) expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "relink" });
    expect(fake.calls.length).toBe(calls); // never loops
    expect(fake.refreshExchanges.refused).toBe(1);
    // the link itself (identity, githubId) stays so the person can renew it with the same account
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubLogin).toBeNull(); // cleared with the relink (F5); githubId and the identity stay so the same account can be linked again
  });

  it("an expired refresh token (by its stored date) is a relink without asking GitHub", async () => {
    const w = await linked();
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000), refreshExpiresAt: new Date(Date.now() - 1000) } });
    const calls = fake.calls.length;
    expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "relink" });
    expect(fake.calls.length).toBe(calls);
  });

  it("GitHub being unreachable while renewing throws a typed error and changes nothing (retried later, not a relink)", async () => {
    const w = await linked();
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const before = await tokenRow(w.owner.id);
    fake.offline = true;
    await expect(getUserAccessToken(db(), cfg(), w.owner.id, deps())).rejects.toBeInstanceOf(GithubAppError);
    fake.offline = false;
    const after = await tokenRow(w.owner.id);
    expect(after!.status).toBe("OK");
    expect(after!.refreshEnc).toBe(before!.refreshEnc);
    expect((await getUserAccessToken(db(), cfg(), w.owner.id, deps())).kind).toBe("ok");
  });

  it("an App that issues tokens without expiry: no date is stored and the token is used until GitHub refuses it", async () => {
    fake.expiringUserTokens = false;
    const w = await linked();
    const row = (await tokenRow(w.owner.id))!;
    expect(row.accessExpiresAt).toBeNull();
    expect(row.refreshEnc).toBeNull();
    expect((await getUserAccessToken(db(), cfg(), w.owner.id, deps())).kind).toBe("ok");
  });

  it("without the encryption key, with another key, or with a ciphertext copied to another person, nothing can be used, but NOTHING is wiped: a key problem never relinks anyone", async () => {
    const w = await linked();
    const other = await addMember(db(), w.ws.id, "other@acme.test", "MEMBER");
    const before = (await tokenRow(w.owner.id))!;
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "no-key" });
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "z".repeat(40)); // another key (a mistake in the middle of a deploy)
    expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "no-key" });
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    expect(await getUserAccessToken(db(), cfg(), w.owner.id, deps())).toEqual({ kind: "no-key" }); // the renewal path too
    expect(logs.some((l) => l.includes("could not be opened"))).toBe(true); // counted, without any value
    const during = (await tokenRow(w.owner.id))!;
    expect(during).toMatchObject({ status: "OK", accessEnc: before.accessEnc, refreshEnc: before.refreshEnc });
    expect((await db().user.findUniqueOrThrow({ where: { id: w.owner.id } })).githubLogin).toBe("octo");
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", ENC_KEY); // the right key is back: everything works again
    expect((await getUserAccessToken(db(), cfg(), w.owner.id, deps())).kind).toBe("ok");
    // a ciphertext copied into another person's row does not open there either, and leaves that row alone
    const mine = (await tokenRow(w.owner.id))!;
    await db().user.update({ where: { id: other.user.id }, data: { githubId: 424242n } });
    await db().githubUserToken.create({ data: { userId: other.user.id, accessEnc: mine.accessEnc, refreshEnc: mine.refreshEnc, accessExpiresAt: mine.accessExpiresAt, refreshExpiresAt: mine.refreshExpiresAt } });
    expect(await getUserAccessToken(db(), cfg(), other.user.id, deps())).toEqual({ kind: "no-key" });
    expect((await tokenRow(other.user.id))!.status).toBe("OK");
  });

  it("no token ever reaches a log, an error message, a cookie or a redirect", async () => {
    const w = await world("octo");
    const b = await begin();
    const res = await linkCallback(authorized(b, "octo"));
    const secret = await plainOf(w.owner.id);
    const refresh = decryptSecret((await tokenRow(w.owner.id))!.refreshEnc!, key(), tokenAad(w.owner.id))!;
    noLeak([secret, refresh, CLIENT_SECRET, ENC_KEY]);
    expect(locationOf(res)).not.toContain(secret);
    expect(JSON.stringify([...state.jar.entries()])).not.toContain(secret);
    expect(JSON.stringify([...state.jar.entries()])).not.toContain(refresh);
    await db().githubUserToken.update({ where: { userId: w.owner.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    fake.invalidateRefreshTokens("octo");
    await getUserAccessToken(db(), cfg(), w.owner.id, deps());
    noLeak([secret, refresh, CLIENT_SECRET, ENC_KEY]);
    const failed = await completeLink(db(), { userId: w.owner.id, state: `${w.ws.id}.${"q".repeat(30)}`, code: "c", nonce: "n", config: cfg(), redirectUri: REDIRECT });
    expect(failed).toBe("invalid-link");
  });
});

// ---------- unlink ----------

describe("unlinking", () => {
  async function linkedWithAccess(login = "octo") {
    const w = await world(login);
    expect(await linkAs(w.owner.id, w.ws.id, login)).toBe("linked");
    await db().githubRepoAccess.create({ data: { userId: w.owner.id, repositoryGithubId: 5n, installationId: 9n, permission: "push", checkedAt: new Date() } });
    await db().dailyDigest.create({ data: { workspaceId: w.ws.id, userId: w.owner.id, day: "2026-11-09", payload: {} as never } });
    return w;
  }

  it("revokes the token at GitHub and deletes the token, the identity, every access row and the stored digests, and clears githubId and githubLogin", async () => {
    const w = await linkedWithAccess();
    const revoked = fake.revokedUserTokens.length;
    const r = await unlinkGithubAction(fd());
    expect(r.ok).toBe(true);
    expect(fake.revokedUserTokens.length).toBe(revoked + 1);
    expect(await db().githubUserToken.count({ where: { userId: w.owner.id } })).toBe(0);
    expect(await db().identity.count({ where: { userId: w.owner.id, provider: "github" } })).toBe(0);
    expect(await db().githubRepoAccess.count({ where: { userId: w.owner.id } })).toBe(0);
    expect(await db().dailyDigest.count({ where: { userId: w.owner.id } })).toBe(0);
    const u = await db().user.findUniqueOrThrow({ where: { id: w.owner.id } });
    expect(u.githubId).toBeNull();
    expect(u.githubLogin).toBeNull();
    expect(await db().auditLog.count({ where: { action: "github.unlink", actorUserId: w.owner.id } })).toBe(1);
  });

  it("is idempotent: unlinking again succeeds, changes nothing and adds no second audit row", async () => {
    const w = await linkedWithAccess();
    expect((await unlinkGithubAction(fd())).ok).toBe(true);
    expect((await unlinkGithubAction(fd())).ok).toBe(true);
    expect(await db().auditLog.count({ where: { action: "github.unlink", actorUserId: w.owner.id } })).toBe(1);
  });

  it("touches only the caller: another person's link, token and access rows stay", async () => {
    const w = await linkedWithAccess("octo");
    fake.addUser("bea");
    const bea = await addMember(db(), w.ws.id, "bea@acme.test", "MEMBER");
    expect(await linkAs(bea.user.id, w.ws.id, "bea")).toBe("linked");
    await db().githubRepoAccess.create({ data: { userId: bea.user.id, repositoryGithubId: 5n, installationId: 9n, permission: "pull", checkedAt: new Date() } });
    await signIn(w.owner.id, w.ws.id);
    await unlinkGithubAction(fd());
    expect(await db().githubUserToken.count({ where: { userId: bea.user.id } })).toBe(1);
    expect(await db().githubRepoAccess.count({ where: { userId: bea.user.id } })).toBe(1);
    expect((await db().user.findUniqueOrThrow({ where: { id: bea.user.id } })).githubLogin).toBe("bea");
  });

  it("still purges when the token cannot be revoked (GitHub unreachable) or the key is gone", async () => {
    const w = await linkedWithAccess();
    fake.offline = true;
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    expect(await unlinkGithubAccount(db(), { userId: w.owner.id, workspaceId: w.ws.id }, cfg())).toBe(true);
    expect(await db().githubUserToken.count()).toBe(0);
    expect(await db().githubRepoAccess.count()).toBe(0);
  });

  it("the person can link again afterwards (a fresh link, nothing carried over)", async () => {
    const w = await linkedWithAccess();
    await unlinkGithubAction(fd());
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    expect(await db().githubRepoAccess.count()).toBe(0);
  });
});

describe("Check again", () => {
  it("queues one refresh job, needs a working link, and cannot be spammed", async () => {
    const w = await world("octo");
    expect(await checkGithubAccessAction(fd())).toMatchObject({ ok: false });
    expect(await linkAs(w.owner.id, w.ws.id, "octo")).toBe("linked");
    await db().job.deleteMany({});
    expect((await checkGithubAccessAction(fd())).ok).toBe(true);
    expect(await db().job.count({ where: { type: ACCESS_JOB } })).toBe(1);
    const second = await checkGithubAccessAction(fd());
    expect(!second.ok && second.error).toMatch(/moment ago/);
    expect(await db().job.count({ where: { type: ACCESS_JOB } })).toBe(1);
    await markRelink(db(), w.owner.id);
    await db().rateLimitState.deleteMany({});
    const r = await checkGithubAccessAction(fd());
    expect(!r.ok && r.error).toMatch(/Link GitHub again/);
  });
});

describe("state and perimeter", () => {
  it("a cross-site POST to the actions never reaches them (proxy), a same-origin one does", () => {
    const post = (origin: string) => proxy(new NextRequest(`${ORIGIN}/settings`, { method: "POST", headers: { host: HOST, origin } }));
    expect(post("https://evil.example").status).toBe(403);
    expect(post(ORIGIN).status).not.toBe(403);
  });

  it("startLink writes its state for the person and workspace it is given and nothing else", async () => {
    const w = await workspaceWithOwner(db());
    const s = await startLink(db(), { viewer: { userId: w.owner.id, workspaceId: w.ws.id }, config: cfg(), redirectUri: REDIRECT });
    expect(s.maxAgeSeconds).toBe(600);
    expect(await db().githubAppState.count({ where: { userId: w.owner.id, workspaceId: w.ws.id, kind: "link" } })).toBe(1);
    expect(await db().githubUserToken.count()).toBe(0);
  });
});
