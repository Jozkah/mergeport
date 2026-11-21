import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, locationOf, request, state } from "./auth-mocks";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { resetGithubAppConfigCache } from "@/lib/github/app-config";
import { InstallationGoneError, InstallationSuspendedError, createInstallationTokenProvider, resetInstallationTokenCache } from "@/lib/github/app-auth";
import { loadBoundInstallation, listWorkspaceInstallations, setRepositoryInstallation } from "@/lib/github/binding";
import { CONNECT_COOKIE, completeConnect, membershipProofProvider, setConnectOverridesForTests, type ProofProvider } from "@/lib/github/connect";
import { noteInstallationError, withInstallationHealth } from "@/lib/github/installation-health";
import { connectionState } from "@/lib/github/connection-state";
import { proxy } from "@/proxy";

vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: m.HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

import { GET as callbackRoute } from "@/app/api/github/app/callback/route";
import { checkGithubInstallationAction, disconnectGithubInstallationAction, startGithubConnectAction } from "@/app/github-actions";

const CLIENT_ID = "Iv1.testclient01";
const CLIENT_SECRET = "client-secret-0123456789-abcdef";
const SLUG = "mergeport-test";
const REDIRECT = `${ORIGIN}/api/github/app/callback`;

let fake: FakeGitHubServer;
let app: ReturnType<FakeGitHubServer["registerApp"]>;
let n = 0;
let errorSpy: ReturnType<typeof vi.spyOn>;

function configure() {
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_GITHUB_APP_ID", app.appId);
  vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", app.privateKeyPem);
  vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "w".repeat(32));
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", SLUG);
  resetGithubAppConfigCache();
}

beforeEach(() => {
  state.db = createTestPrisma(`github-connect-${n++}`);
  state.jar.clear();
  fake = new FakeGitHubServer();
  app = fake.registerApp("12345");
  fake.setOAuthClient(CLIENT_ID, CLIENT_SECRET);
  configure();
  setConnectOverridesForTests({ deps: { fetch: fake.appFetch() } });
  resetInstallationTokenCache();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  setConnectOverridesForTests(null);
  vi.unstubAllEnvs();
  resetGithubAppConfigCache();
  errorSpy.mockRestore();
  await state.db!.$disconnect();
});
const db = () => state.db!;

// ---------- helpers ----------

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function signIn(userId: string, workspaceId: string) {
  const { token } = await createSession(db(), userId, new Date(), workspaceId);
  state.jar.set(SESSION_COOKIE, { value: token, options: {} });
}
const resultOf = (res: Response) => new URL(locationOf(res)).searchParams.get("github");

/** A workspace with an owner who is signed in, and the matching GitHub user. */
async function world(githubLogin = "octo") {
  const w = await workspaceWithOwner(db());
  if (!fake.users.has(githubLogin)) fake.addUser(githubLogin);
  await signIn(w.owner.id, w.ws.id);
  return w;
}

/** Presses "Connect GitHub" (or "Use an existing installation") and returns what the browser would be sent to, plus the nonce it keeps. */
async function begin(mode: "install" | "existing" = "install", account = "") {
  const r = await startGithubConnectAction(fd({ mode, account }));
  if (!r.ok) throw new Error(`start refused: ${r.error}`);
  const url = new URL(String(r.data?.redirect));
  return { url, state: url.searchParams.get("state")!, nonce: state.jar.get(CONNECT_COOKIE)?.value ?? "" };
}

/** What GitHub does after the install page: redirect back with installation_id, setup_action, a code for `githubLogin`, and the state. */
function afterInstall(b: { state: string }, githubLogin: string, installationId: number | string, extra: Record<string, string> = {}) {
  const code = fake.issueOAuthCode(githubLogin, { redirectUri: REDIRECT });
  const q = new URLSearchParams({ installation_id: String(installationId), setup_action: "install", code, state: b.state, ...extra });
  return request(`/api/github/app/callback?${q.toString()}`);
}
/** After the authorize page: code and state only (no installation id), bound to the PKCE challenge in the authorize address. */
function afterAuthorize(b: { url: URL; state: string }, githubLogin: string, extra: Record<string, string> = {}) {
  const code = fake.issueOAuthCode(githubLogin, { redirectUri: REDIRECT, codeChallenge: b.url.searchParams.get("code_challenge") ?? undefined });
  const q = new URLSearchParams({ code, state: b.state, ...extra });
  return request(`/api/github/app/callback?${q.toString()}`);
}
const bindings = (workspaceId: string) => db().workspaceInstallation.findMany({ where: { workspaceId } });

// ---------- start ----------

describe("starting the connect flow", () => {
  it("sends an administrator to the App's install page with a single-use state, and keeps only hashes", async () => {
    const w = await world();
    const b = await begin();
    expect(b.url.origin + b.url.pathname).toBe(`https://github.com/apps/${SLUG}/installations/new`);
    expect(b.state.startsWith(`${w.ws.id}.`)).toBe(true);
    const rows = await db().githubAppState.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: w.ws.id, userId: w.owner.id, kind: "connect", usedAt: null });
    expect(rows[0].stateHash).toBe(createHash("sha256").update(b.state).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(b.state);
    expect(JSON.stringify(rows)).not.toContain(b.nonce);
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it("sets the nonce as a short-lived HttpOnly SameSite=Lax cookie that is only sent to the callback path", async () => {
    await world();
    await begin();
    const c = state.jar.get(CONNECT_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/api/github/app", maxAge: 600 });
  });

  it("'Use an existing installation' goes through the OAuth authorize page with PKCE S256 and no secret", async () => {
    await world();
    const b = await begin("existing", "acme");
    expect(b.url.origin + b.url.pathname).toBe("https://github.com/login/oauth/authorize");
    const q = b.url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(b.nonce).digest("base64url"));
    expect(b.url.toString()).not.toContain(CLIENT_SECRET);
    expect(b.url.toString()).not.toContain(b.nonce);
    expect((await db().githubAppState.findFirstOrThrow()).kind).toBe("connect-existing:acme");
  });

  it("refuses a member, a reader and a nonsense account name (the server decides, not the hidden button)", async () => {
    const w = await world();
    const m = await addMember(db(), w.ws.id, "member@example.com", "MEMBER");
    const r = await addMember(db(), w.ws.id, "reader@example.com", "READER");
    for (const u of [m.user, r.user]) {
      await signIn(u.id, w.ws.id);
      const out = await startGithubConnectAction(fd({ mode: "install" }));
      expect(out.ok).toBe(false);
    }
    await signIn(w.owner.id, w.ws.id);
    expect((await startGithubConnectAction(fd({ mode: "existing", account: "not a login!" }))).ok).toBe(false);
    expect(await db().githubAppState.count()).toBe(0);
    expect(state.jar.has(CONNECT_COOKIE)).toBe(false);
  });

  it("says so clearly when the server has no GitHub App, and when the workspace is not hosted", async () => {
    await world();
    for (const k of ["ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "CLIENT_ID", "CLIENT_SECRET", "SLUG"]) vi.stubEnv(`MERGEPORT_GITHUB_APP_${k}`, "");
    resetGithubAppConfigCache();
    const out = await startGithubConnectAction(fd({ mode: "install" }));
    expect(out).toMatchObject({ ok: false });
    expect(!out.ok && out.error).toMatch(/not set up on this server/);
    configure();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await startGithubConnectAction(fd({ mode: "install" }))).ok).toBe(false);
    expect(await db().githubAppState.count()).toBe(0);
  });

  it("is rate limited per person", async () => {
    await world();
    for (let i = 0; i < 15; i++) expect((await startGithubConnectAction(fd({ mode: "install" }))).ok).toBe(true);
    const out = await startGithubConnectAction(fd({ mode: "install" }));
    expect(!out.ok && out.error).toMatch(/Too many attempts/);
  });

  it("a cross-site POST never reaches the action (proxy), a same-origin one does", () => {
    const post = (origin: string) => proxy(new NextRequest(`${ORIGIN}/settings/github`, { method: "POST", headers: { host: HOST, origin } }));
    expect(post("https://evil.example").status).toBe(403);
    expect(post(ORIGIN).status).toBe(200);
  });
});

// ---------- callback: success ----------

describe("callback: a person who controls the installation connects it", () => {
  it("USER account: binds with proof, audits, revokes the user token, redirects with a fixed code", async () => {
    const w = await world();
    const user = fake.users.get("octo")!;
    const inst = fake.addInstallation("octo", { selection: "all" });
    const b = await begin();
    const res = await callbackRoute(afterInstall(b, "octo", inst.id));
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`${ORIGIN}/settings/github?github=connected`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("");

    const rows = await bindings(w.ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ installationId: BigInt(inst.id), connectedByUserId: w.owner.id, verifiedGithubUserId: BigInt(user.id), proofMethod: "user-installations:self" });
    expect(rows[0].verifiedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await db().githubInstallation.findUniqueOrThrow({ where: { installationId: BigInt(inst.id) } })).toMatchObject({ accountLogin: "octo", accountType: "USER", repositorySelection: "ALL", suspendedAt: null, deletedAt: null });
    expect(await db().auditLog.count({ where: { workspaceId: w.ws.id, action: "github.connect", actorUserId: w.owner.id } })).toBe(1);
    expect(fake.revokedUserTokens).toHaveLength(1); // the user token was ended at GitHub
    expect(state.jar.has(CONNECT_COOKIE)).toBe(false); // the nonce cookie is single use
    expect(await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id))).not.toBeNull();
    expect(await connectionState(db(), w.ws.id)).toBe("ok");
  });

  it("ORGANIZATION: an owner of the organization connects it", async () => {
    const w = await world();
    fake.addOrg("acme", ["octo"]);
    const inst = fake.addInstallation("acme");
    const b = await begin();
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("connected");
    const [row] = await bindings(w.ws.id);
    expect(row).toMatchObject({ installationId: BigInt(inst.id), proofMethod: "user-installations:org-admin" });
    expect((await db().githubInstallation.findUniqueOrThrow({ where: { installationId: BigInt(inst.id) } })).accountType).toBe("ORGANIZATION");
  });

  it("'Use an existing installation': picks the named account, sends the PKCE verifier, and connects", async () => {
    const w = await world();
    fake.addOrg("acme", ["octo"]);
    fake.addOrg("beta", ["octo"]);
    const acme = fake.addInstallation("acme");
    fake.addInstallation("beta");
    const b = await begin("existing", "ACME"); // case does not matter
    expect(resultOf(await callbackRoute(afterAuthorize(b, "octo")))).toBe("connected");
    expect((await bindings(w.ws.id)).map((r) => r.installationId)).toEqual([BigInt(acme.id)]);
    expect(fake.oauthExchanges.at(-1)).toMatchObject({ ok: true, verifier: b.nonce, redirectUri: REDIRECT });
  });

  it("'Use an existing installation' without a name: one installation connects, several ask for the name, none is 'not found'", async () => {
    const w = await world();
    fake.addOrg("acme", ["octo"]);
    fake.addOrg("beta", ["octo"]);
    let b = await begin("existing");
    expect(resultOf(await callbackRoute(afterAuthorize(b, "octo")))).toBe("not-found"); // nothing installed yet
    const acme = fake.addInstallation("acme");
    b = await begin("existing");
    expect(resultOf(await callbackRoute(afterAuthorize(b, "octo")))).toBe("connected");
    fake.addInstallation("beta");
    b = await begin("existing");
    expect(resultOf(await callbackRoute(afterAuthorize(b, "octo")))).toBe("several");
    expect((await bindings(w.ws.id)).map((r) => r.installationId)).toEqual([BigInt(acme.id)]);
  });

  it("the same workspace and installation again is idempotent (one row, proof refreshed)", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("connected");
    const first = (await bindings(w.ws.id))[0];
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("already");
    const rows = await bindings(w.ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].verifiedAt.getTime()).toBeGreaterThanOrEqual(first.verifiedAt.getTime());
  });

  it("finds an installation on the second page of GET /user/installations", async () => {
    const w = await world();
    for (let i = 0; i < 105; i++) {
      fake.addOrg(`org-${i}`, ["octo"]);
      fake.addInstallation(`org-${i}`);
    }
    const last = [...fake.installations.values()].at(-1)!;
    const b = await begin();
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", last.id)))).toBe("connected");
    expect((await bindings(w.ws.id))[0].installationId).toBe(BigInt(last.id));
    expect(fake.calls.filter((c) => c.includes("/user/installations?")).length).toBe(2);
  });
});

// ---------- callback: refusals ----------

describe("callback: every refusal binds nothing", () => {
  it("not signed in: sends the person to sign in, consumes nothing, never trusts the query", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    const b = await begin();
    state.jar.delete(SESSION_COOKIE);
    const res = await callbackRoute(afterInstall(b, "octo", inst.id));
    expect(locationOf(res)).toBe(`${ORIGIN}/sign-in?next=%2Fsettings%2Fgithub`);
    expect((await db().githubAppState.findFirstOrThrow()).usedAt).toBeNull();
    expect(fake.oauthExchanges).toHaveLength(0);
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("replaying a callback URL fails (the state is single use) and does not call GitHub again", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    const b = await begin();
    const url = afterInstall(b, "octo", inst.id).url;
    expect(resultOf(await callbackRoute(request(new URL(url).pathname + new URL(url).search)))).toBe("connected");
    const seen = fake.oauthExchanges.length;
    state.jar.set(CONNECT_COOKIE, { value: b.nonce, options: {} }); // even with the cookie put back
    expect(resultOf(await callbackRoute(request(new URL(url).pathname + new URL(url).search)))).toBe("invalid-link");
    expect(fake.oauthExchanges).toHaveLength(seen);
    expect(await bindings(w.ws.id)).toHaveLength(1);
  });

  it("an expired state fails", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    const b = await begin();
    await db().githubAppState.updateMany({ where: { workspaceId: w.ws.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("invalid-link");
    expect(await bindings(w.ws.id)).toHaveLength(0);
    expect(fake.oauthExchanges).toHaveLength(0);
  });

  it("a state minted for person A and used by person B fails, and burns the state", async () => {
    const w = await world();
    const bob = await addMember(db(), w.ws.id, "bob@example.com", "ADMIN");
    fake.addUser("bobhub");
    const inst = fake.addInstallation("octo");
    const b = await begin(); // A = owner
    await signIn(bob.user.id, w.ws.id);
    state.jar.set(CONNECT_COOKIE, { value: b.nonce, options: {} }); // B even holds A's nonce
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("invalid-link");
    await signIn(w.owner.id, w.ws.id);
    state.jar.set(CONNECT_COOKIE, { value: b.nonce, options: {} });
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("invalid-link"); // already used
    expect(await bindings(w.ws.id)).toHaveLength(0);
    expect(fake.oauthExchanges).toHaveLength(0);
  });

  it("a missing or different nonce cookie fails (another browser cannot finish the flow)", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    let b = await begin();
    state.jar.delete(CONNECT_COOKIE);
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("invalid-link");
    b = await begin();
    state.jar.set(CONNECT_COOKIE, { value: "not-the-nonce-not-the-nonce-not-the-nonce-00", options: {} });
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("invalid-link");
    expect(await bindings(w.ws.id)).toHaveLength(0);
    expect(fake.oauthExchanges).toHaveLength(0);
  });

  it("garbage, foreign and workspace-swapped state values fail", async () => {
    const a = await world();
    const other = await workspaceWithOwner(db(), "other@example.com", "Other");
    await signIn(a.owner.id, a.ws.id);
    const inst = fake.addInstallation("octo");
    const b = await begin();
    const random = b.state.split(".")[1];
    for (const s of ["", "x", "a.b", `${other.ws.id}.${random}`, `${a.ws.id}.${random}x`, "../../etc/passwd", `${a.ws.id}.${"A".repeat(500)}`]) {
      state.jar.set(CONNECT_COOKIE, { value: b.nonce, options: {} });
      expect(resultOf(await callbackRoute(afterInstall({ state: s }, "octo", inst.id)))).toBe("invalid-link");
    }
    expect(await bindings(a.ws.id)).toHaveLength(0);
    expect(await bindings(other.ws.id)).toHaveLength(0);
    expect((await db().githubAppState.findFirstOrThrow()).usedAt).toBeNull(); // the real one was never claimed by a forgery
  });

  it("the installation id in the query is only a claim: one the person cannot see is refused", async () => {
    const w = await world();
    fake.addUser("stranger");
    const mine = fake.addInstallation("octo");
    const theirs = fake.addInstallation("stranger");
    const b = await begin();
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", theirs.id)))).toBe("cannot-verify");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", 424242)))).toBe("cannot-verify");
    for (const bad of ["abc", "0", "-5", "1e9", "99999999999999999999", ""]) expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", bad)))).toBe("cannot-verify");
    expect(await bindings(w.ws.id)).toHaveLength(0);
    expect(mine.id).toBeGreaterThan(0);
  });

  it("an organization member who is not an owner is refused; so is any doubt about the membership answer", async () => {
    const w = await world();
    fake.addOrg("acme", ["boss"], ["octo"]);
    const inst = fake.addInstallation("acme");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("not-owner");
    // the owner, but GitHub answers 403 to the membership call (the App lacks the permission): refused, never a success
    fake.addOrg("beta", ["octo"]);
    const beta = fake.addInstallation("beta");
    fake.forbidOrgMemberships = true;
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", beta.id)))).toBe("not-owner");
    fake.forbidOrgMemberships = false;
    fake.failNext(/\/user\/memberships\/orgs\/beta/, 500, "boom");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", beta.id)))).toBe("not-owner");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("the proof provider treats pending and non-admin answers, and odd bodies, as refusals", async () => {
    const facts = { installationId: 1n, accountGithubId: 5n, accountLogin: "acme", accountType: "ORGANIZATION" as const, repositorySelection: "ALL" as const, suspendedAt: null };
    const prove = (body: unknown, status = 200) =>
      membershipProofProvider.prove({ deps: { fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch }, userToken: "t", user: { id: 9n, login: "x" }, facts });
    expect(await prove({ role: "admin", state: "active" })).toEqual({ ok: true, method: "user-installations:org-admin" });
    for (const [b, s] of [[{ role: "admin", state: "pending" }, 200], [{ role: "member", state: "active" }, 200], [{ role: "ADMIN", state: "active" }, 200], [{}, 200], [null, 200], [{ role: "admin", state: "active" }, 404], [{ role: "admin", state: "active" }, 403], [{ role: "admin", state: "active" }, 302]] as const) {
      expect((await prove(b, s)).ok).toBe(false);
    }
    const user = (id: bigint) => membershipProofProvider.prove({ deps: {}, userToken: "t", user: { id, login: "x" }, facts: { ...facts, accountType: "USER", accountGithubId: 5n } });
    expect((await user(5n)).ok).toBe(true);
    expect((await user(6n)).ok).toBe(false);
  });

  it("a personal installation of someone else is refused even if GitHub lists it", async () => {
    const w = await world();
    fake.addUser("friend");
    const theirs = fake.addInstallation("friend");
    // Simulate GitHub listing it for octo anyway (a collaborator view): the account id must match the person.
    const spy: ProofProvider = membershipProofProvider;
    setConnectOverridesForTests({ deps: { fetch: (async (u: RequestInfo | URL, i?: RequestInit) => {
      const url = new URL(String(u));
      if (url.pathname === "/user/installations") return new Response(JSON.stringify({ total_count: 1, installations: [{ id: theirs.id, account: { id: fake.users.get("friend")!.id, login: "friend", type: "User" } }] }), { status: 200 });
      return fake.appFetch()(u, i);
    }) as typeof fetch }, proof: spy });
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", theirs.id)))).toBe("not-yours");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("a bad code, a code for another redirect and a PKCE mismatch are refused", async () => {
    const w = await world();
    fake.addOrg("acme", ["octo"]);
    const inst = fake.addInstallation("acme");
    let b = await begin();
    const q = new URLSearchParams({ installation_id: String(inst.id), setup_action: "install", code: "not-a-real-code", state: b.state });
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${q}`)))).toBe("cannot-verify");
    b = await begin("existing", "acme");
    const wrongRedirect = fake.issueOAuthCode("octo", { redirectUri: "https://evil.example/cb", codeChallenge: b.url.searchParams.get("code_challenge")! });
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${new URLSearchParams({ code: wrongRedirect, state: b.state })}`)))).toBe("cannot-verify");
    b = await begin("existing", "acme");
    const mismatch = fake.issueOAuthCode("octo", { redirectUri: REDIRECT, codeChallenge: createHash("sha256").update("another-verifier").digest("base64url") });
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${new URLSearchParams({ code: mismatch, state: b.state })}`)))).toBe("cannot-verify");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("install without a code, a pending organization request, and a person who declined all bind nothing", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    let b = await begin();
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${new URLSearchParams({ installation_id: String(inst.id), setup_action: "install", state: b.state })}`)))).toBe("no-authorization");
    b = await begin();
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${new URLSearchParams({ setup_action: "request", state: b.state })}`)))).toBe("request-pending");
    b = await begin("existing");
    expect(resultOf(await callbackRoute(request(`/api/github/app/callback?${new URLSearchParams({ error: "access_denied", state: b.state })}`)))).toBe("cannot-verify");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("a suspended installation is refused", async () => {
    const w = await world();
    fake.listSuspendedForUsers = true;
    const inst = fake.addInstallation("octo", { suspended: true });
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("suspended");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("GitHub being unreachable binds nothing and says so", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    const b = await begin();
    fake.offline = true;
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("unavailable");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });

  it("a person who is no longer allowed (demoted or removed) after starting cannot finish", async () => {
    const w = await world();
    const bob = await addMember(db(), w.ws.id, "bob@example.com", "ADMIN");
    fake.addUser("bobhub");
    const inst = fake.addInstallation("bobhub");
    await signIn(bob.user.id, w.ws.id);
    let b = await begin();
    await db().member.updateMany({ where: { id: bob.member.id, workspaceId: w.ws.id }, data: { role: "MEMBER" } });
    expect(resultOf(await callbackRoute(afterInstall(b, "bobhub", inst.id)))).toBe("not-allowed");
    await db().member.updateMany({ where: { id: bob.member.id, workspaceId: w.ws.id }, data: { role: "ADMIN" } });
    b = await begin();
    await db().member.updateMany({ where: { id: bob.member.id, workspaceId: w.ws.id }, data: { status: "REVOKED" } });
    await signIn(bob.user.id, w.ws.id);
    expect(resultOf(await callbackRoute(afterInstall(b, "bobhub", inst.id)))).toBe("not-allowed");
    expect(await bindings(w.ws.id)).toHaveLength(0);
    expect(fake.oauthExchanges).toHaveLength(0);
  });

  it("is rate limited per person", async () => {
    await world();
    const codes: (string | null)[] = [];
    for (let i = 0; i < 22; i++) codes.push(resultOf(await callbackRoute(request("/api/github/app/callback?state=x"))));
    expect(codes.slice(0, 20).every((c) => c === "invalid-link")).toBe(true);
    expect(codes[20]).toBe("rate-limited");
  });

  it("answers 404 when the App is not configured or the server is not hosted", async () => {
    await world();
    vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "");
    resetGithubAppConfigCache();
    expect((await callbackRoute(request("/api/github/app/callback?state=x"))).status).toBe(404);
    configure();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await callbackRoute(request("/api/github/app/callback?state=x"))).status).toBe(404);
  });

  it("an unexpected failure is a generic message that carries no value", async () => {
    const w = await world();
    const inst = fake.addInstallation("octo");
    const b = await begin();
    const boom: ProofProvider = { prove: async () => { throw new Error("secret detail ghu_leak"); } };
    const url = afterInstall(b, "octo", inst.id).url;
    const res = await completeConnect(db(), {
      userId: w.owner.id, state: new URL(url).searchParams.get("state"), code: new URL(url).searchParams.get("code"), installationId: String(inst.id), setupAction: "install",
      nonce: b.nonce, config: (await import("@/lib/github/app-config")).githubAppConfig()!, redirectUri: REDIRECT, deps: { fetch: fake.appFetch() }, proof: boom,
    });
    expect(res).toBe("error");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("ghu_leak");
    expect(await bindings(w.ws.id)).toHaveLength(0);
  });
});

// ---------- tenant isolation ----------

describe("workspaces stay apart", () => {
  it("a connect started in workspace A binds only A; a state cannot be steered at B", async () => {
    const a = await world();
    const b2 = await workspaceWithOwner(db(), "b-owner@example.com", "B");
    await db().member.create({ data: { workspaceId: b2.ws.id, userId: a.owner.id, role: "ADMIN", status: "ACTIVE" } }); // the same person administers both
    await signIn(a.owner.id, a.ws.id);
    const inst = fake.addInstallation("octo");
    const b = await begin();
    expect(b.state.startsWith(`${a.ws.id}.`)).toBe(true);
    // steering: swap the workspace prefix to B's
    const steered = { state: `${b2.ws.id}.${b.state.split(".")[1]}` };
    expect(resultOf(await callbackRoute(afterInstall(steered, "octo", inst.id)))).toBe("invalid-link");
    state.jar.set(CONNECT_COOKIE, { value: b.nonce, options: {} });
    expect(resultOf(await callbackRoute(afterInstall(b, "octo", inst.id)))).toBe("connected");
    expect(await bindings(a.ws.id)).toHaveLength(1);
    expect(await bindings(b2.ws.id)).toHaveLength(0);
    expect(await db().auditLog.count({ where: { workspaceId: b2.ws.id } })).toBe(0);
  });

  it("an installation already bound elsewhere needs the new workspace's own proof; one proof does not carry over", async () => {
    const a = await world();
    fake.addOrg("acme", ["octo"]);
    const inst = fake.addInstallation("acme");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("connected");

    // Workspace B's admin is "mallory": a member of the org, not an owner. Workspace A's binding is no proof for her.
    const b = await workspaceWithOwner(db(), "mallory@example.com", "B");
    fake.addUser("mallory");
    fake.orgs.get("acme")!.members.add("mallory");
    await signIn(b.owner.id, b.ws.id);
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "mallory", inst.id)))).toBe("not-owner");
    expect(await bindings(b.ws.id)).toHaveLength(0);

    // A person who cannot even see the installation is refused too.
    fake.addUser("nobody");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "nobody", inst.id)))).toBe("cannot-verify");
    expect(await bindings(b.ws.id)).toHaveLength(0);

    // The real owner proves it again for B: now two workspaces use the one installation, each with its own proof row.
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("connected");
    expect(await bindings(b.ws.id)).toHaveLength(1);
    expect(await bindings(a.ws.id)).toHaveLength(1);
    expect(await db().githubInstallation.count({ where: { installationId: BigInt(inst.id) } })).toBe(1);
  });
});

// ---------- disconnect ----------

describe("disconnecting", () => {
  async function connected() {
    const w = await world();
    const inst = fake.addInstallation("octo");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("connected");
    const owner = await db().githubOwner.create({ data: { githubId: 777n, login: "octo", type: "USER" } });
    const repo = await db().repository.create({ data: { workspaceId: w.ws.id, githubId: 1n, ownerId: owner.id, name: "r", fullName: "octo/r", htmlUrl: "https://github.com/octo/r" } });
    await setRepositoryInstallation(db(), w.ws.id, repo.id, BigInt(inst.id));
    return { w, inst, repo };
  }

  it("removes the binding, detaches repositories (they stay), keeps planning data, audits, and leaves other workspaces alone", async () => {
    const { w, inst, repo } = await connected();
    const other = await workspaceWithOwner(db(), "other@example.com", "Other");
    await db().workspaceInstallation.create({ data: { workspaceId: other.ws.id, installationId: BigInt(inst.id), verifiedAt: new Date(), verifiedGithubUserId: 1n, proofMethod: "user-installations:self" } });
    const out = await disconnectGithubInstallationAction(fd({ installationId: String(inst.id) }));
    expect(out.ok).toBe(true);
    expect(await bindings(w.ws.id)).toHaveLength(0);
    const kept = await db().repository.findFirstOrThrow({ where: { id: repo.id, workspaceId: w.ws.id } });
    expect(kept.installationId).toBeNull();
    expect(await db().auditLog.count({ where: { workspaceId: w.ws.id, action: "github.disconnect" } })).toBe(1);
    expect(await bindings(other.ws.id)).toHaveLength(1); // untouched
    expect(await db().githubInstallation.count({ where: { installationId: BigInt(inst.id) } })).toBe(1);
    expect(await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id))).toBeNull();
    expect(await connectionState(db(), w.ws.id)).toBe("none");
  });

  it("a member and a reader cannot disconnect (server enforced), and another workspace's id is 'not found'", async () => {
    const { w, inst } = await connected();
    const m = await addMember(db(), w.ws.id, "member@example.com", "MEMBER");
    const r = await addMember(db(), w.ws.id, "reader@example.com", "READER");
    for (const u of [m.user, r.user]) {
      await signIn(u.id, w.ws.id);
      expect((await disconnectGithubInstallationAction(fd({ installationId: String(inst.id) }))).ok).toBe(false);
    }
    expect(await bindings(w.ws.id)).toHaveLength(1);
    const other = await workspaceWithOwner(db(), "other@example.com", "Other");
    await signIn(other.owner.id, other.ws.id);
    expect((await disconnectGithubInstallationAction(fd({ installationId: String(inst.id) }))).ok).toBe(false);
    expect((await disconnectGithubInstallationAction(fd({ installationId: "nonsense" }))).ok).toBe(false);
    expect(await bindings(w.ws.id)).toHaveLength(1);
  });
});

// ---------- loss detection ----------

describe("detecting an installation that is gone or suspended", () => {
  async function bound() {
    const w = await world();
    const inst = fake.addInstallation("octo");
    expect(resultOf(await callbackRoute(afterInstall(await begin(), "octo", inst.id)))).toBe("connected");
    const bi = (await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id)))!;
    return { w, inst, bi };
  }

  it("a 404 marks it removed and a 403 'suspended' marks it suspended; the page shows both and no token is handed out", async () => {
    const { w, inst, bi } = await bound();
    const provider = withInstallationHealth(db(), createInstallationTokenProvider({ config: (await import("@/lib/github/app-config")).githubAppConfig(), fetch: fake.appFetch() }));
    fake.installations.get(inst.id)!.suspended = true;
    await expect(provider.getToken(bi)).rejects.toBeInstanceOf(InstallationSuspendedError);
    expect((await listWorkspaceInstallations(db(), w.ws.id))[0].status).toBe("suspended");
    expect(await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id))).toBeNull();
    expect(await connectionState(db(), w.ws.id)).toBe("suspended");

    fake.installations.delete(inst.id);
    resetInstallationTokenCache();
    await expect(provider.getToken(bi)).rejects.toBeInstanceOf(InstallationGoneError);
    expect((await listWorkspaceInstallations(db(), w.ws.id))[0].status).toBe("removed");
    expect(await connectionState(db(), w.ws.id)).toBe("removed");
  });

  it("other errors are not losses", async () => {
    const { inst } = await bound();
    expect(await noteInstallationError(db(), BigInt(inst.id), new Error("network"))).toBe(false);
    expect((await db().githubInstallation.findUniqueOrThrow({ where: { installationId: BigInt(inst.id) } })).deletedAt).toBeNull();
  });

  it("'Check again' picks up an unsuspended installation, and records a removed one; only this workspace's own binding can be checked", async () => {
    const { w, inst, bi } = await bound();
    const provider = withInstallationHealth(db(), createInstallationTokenProvider({ config: (await import("@/lib/github/app-config")).githubAppConfig(), fetch: fake.appFetch() }));
    fake.installations.get(inst.id)!.suspended = true;
    await provider.getToken(bi).catch(() => {});
    fake.installations.get(inst.id)!.suspended = false;
    expect((await checkGithubInstallationAction(fd({ installationId: String(inst.id) }))).ok).toBe(true);
    expect((await listWorkspaceInstallations(db(), w.ws.id))[0].status).toBe("active");
    fake.installations.delete(inst.id);
    await checkGithubInstallationAction(fd({ installationId: String(inst.id) }));
    expect((await listWorkspaceInstallations(db(), w.ws.id))[0].status).toBe("removed");
    const other = await workspaceWithOwner(db(), "other@example.com", "Other");
    await signIn(other.owner.id, other.ws.id);
    expect((await checkGithubInstallationAction(fd({ installationId: String(inst.id) }))).ok).toBe(false);
  });
});

// ---------- secrets ----------

describe("nothing secret leaves the server or is kept", () => {
  it("the user token, the code, the client secret and the nonce appear in no response, redirect, row or log line", async () => {
    const w = await world();
    fake.addOrg("acme", ["octo"]);
    const inst = fake.addInstallation("acme");
    const b = await begin();
    const req = afterInstall(b, "octo", inst.id);
    const code = new URL(req.url).searchParams.get("code")!;
    const res = await callbackRoute(req);
    const token = fake.revokedUserTokens[0];
    expect(token).toMatch(/^ghu_/);
    const everything = JSON.stringify([
      locationOf(res), [...res.headers.entries()], await res.text(),
      await db().githubAppState.findMany(), await db().githubInstallation.findMany(), await bindings(w.ws.id), await db().auditLog.findMany(),
      errorSpy.mock.calls, [...state.jar.entries()].filter(([k]) => k !== SESSION_COOKIE),
    ], (_k, v) => (typeof v === "bigint" ? String(v) : v));
    for (const secret of [token, code, CLIENT_SECRET, b.nonce, b.state]) expect(everything).not.toContain(secret);
    expect(locationOf(res)).not.toMatch(/token|code=|installation/i);
  });

  it("no query value decides where the callback redirects (no open redirect)", async () => {
    await world();
    for (const extra of ["&next=https://evil.example", "&redirect_uri=https://evil.example", "&return_to=//evil.example", "&github=connected"]) {
      const res = await callbackRoute(request(`/api/github/app/callback?state=x${extra}`));
      expect(locationOf(res)).toBe(`${ORIGIN}/settings/github?github=invalid-link`);
    }
    state.jar.delete(SESSION_COOKIE);
    expect(locationOf(await callbackRoute(request("/api/github/app/callback?state=x&next=https://evil.example")))).toBe(`${ORIGIN}/sign-in?next=%2Fsettings%2Fgithub`);
  });
});
