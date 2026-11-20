import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, RecordingMailer, locationOf, pathOf, request, state } from "./auth-mocks";
import { setMailerForTests } from "@/lib/auth/mailer";
import { consumeMagicLink, requestMagicLink } from "@/lib/auth/magic-link";
import { OIDC_COOKIE, beginOidc, completeOidc, findProvider, oidcProviders, openFlow, sealFlow, setOidcProtocolForTests, type OidcProtocol, type OidcTokenClaims } from "@/lib/auth/oidc";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";

vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const SECRET = "test-secret-test-secret-test-secret-0123";
const ISSUER = "https://issuer.example";

/** A stand-in for the openid-client boundary: records what it was asked and answers with whatever the test sets. */
function fakeProtocol() {
  const f = {
    seen: { authz: null as null | { state: string; nonce: string; codeChallenge: string; redirectUri: string }, exchangeCalls: 0 },
    claims: (a: { nonce: string }): OidcTokenClaims => ({ sub: "sub-1", email: "p@example.com", email_verified: true, nonce: a.nonce }),
    fail: false,
  };
  const proto: OidcProtocol = {
    async authorizationUrl(_p, a) {
      f.seen.authz = a;
      const u = new URL(`${ISSUER}/authorize`);
      u.searchParams.set("state", a.state);
      return u;
    },
    async exchange(_p, a) {
      f.seen.exchangeCalls++;
      if (f.fail) throw new Error("invalid_grant token=secret-token-value");
      return f.claims(a);
    },
  };
  return { f, proto };
}

let n = 0;
let fake: ReturnType<typeof fakeProtocol>;
const T0 = new Date();
const db = () => state.db!;

beforeEach(() => {
  state.db = createTestPrisma(`auth-oidc-${n++}`);
  state.jar.clear();
  fake = fakeProtocol();
  setOidcProtocolForTests(fake.proto);
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_AUTH_SECRET", SECRET);
  vi.stubEnv("OIDC_GOOGLE_ISSUER", ISSUER);
  vi.stubEnv("OIDC_GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("OIDC_GOOGLE_CLIENT_SECRET", "csecret");
});
afterEach(() => {
  setOidcProtocolForTests(null);
  setMailerForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const provider = () => findProvider("google")!;
/** Runs start then callback the way a browser would, returning the callback result. */
async function login(claimsOverride?: Partial<OidcTokenClaims>, opts: { next?: string } = {}) {
  const { url, cookie } = await beginOidc(provider(), { origin: ORIGIN, next: opts.next, now: T0.getTime() });
  if (claimsOverride) fake.f.claims = (a) => ({ sub: "sub-1", email: "p@example.com", email_verified: true, nonce: a.nonce, ...claimsOverride });
  const callbackUrl = new URL(`${ORIGIN}/auth/oidc/google/callback?code=abc&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
  return completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl, cookie, now: T0 });
}
const callbackFor = (cookie: string, stateValue: string) => new URL(`${ORIGIN}/auth/oidc/google/callback?code=abc&state=${encodeURIComponent(stateValue)}`);

describe("provider configuration", () => {
  it("reads OIDC_<NAME>_ISSUER / CLIENT_ID / CLIENT_SECRET, needs all three, and labels google and microsoft", () => {
    const list = oidcProviders({
      OIDC_GOOGLE_ISSUER: "https://accounts.google.com", OIDC_GOOGLE_CLIENT_ID: "a", OIDC_GOOGLE_CLIENT_SECRET: "b",
      OIDC_MICROSOFT_ISSUER: "https://login.microsoftonline.com/t/v2.0", OIDC_MICROSOFT_CLIENT_ID: "c", OIDC_MICROSOFT_CLIENT_SECRET: "d",
      OIDC_HALF_ISSUER: "https://half.example", OIDC_HALF_CLIENT_ID: "x",
    });
    expect(list.map((p) => [p.name, p.label])).toEqual([["google", "Google"], ["microsoft", "Microsoft"]]);
    expect(findProvider("half")).toBeNull();
    expect(findProvider("nope")).toBeNull();
  });
});

describe("the flow cookie", () => {
  it("carries PKCE (S256), state and nonce; the challenge is the hash of the verifier in the cookie", async () => {
    const { url, cookie } = await beginOidc(provider(), { origin: ORIGIN, next: "/x", now: T0.getTime() });
    const flow = openFlow(cookie, T0.getTime())!;
    const a = fake.f.seen.authz!;
    expect(a.redirectUri).toBe(`${ORIGIN}/auth/oidc/google/callback`);
    expect(a.state).toBe(flow.s);
    expect(a.nonce).toBe(flow.n);
    expect(a.state).not.toBe(a.nonce);
    expect(a.codeChallenge).toBe(createHash("sha256").update(flow.v).digest("base64url"));
    expect(url.searchParams.get("state")).toBe(flow.s);
    expect(flow.next).toBe("/x");
  });

  it("rejects a forged signature, an altered payload, an expired cookie and another secret", async () => {
    const { cookie } = await beginOidc(provider(), { origin: ORIGIN, now: T0.getTime() });
    const [payload, sig] = cookie.split(".");
    expect(openFlow(cookie, T0.getTime())).not.toBeNull();
    expect(openFlow(`${payload}.${sig.slice(0, -2)}AA`, T0.getTime())).toBeNull();
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), next: "//evil.example" })).toString("base64url");
    expect(openFlow(`${evil}.${sig}`, T0.getTime())).toBeNull();
    expect(openFlow(cookie, T0.getTime() + 11 * 60_000)).toBeNull();
    vi.stubEnv("MERGEPORT_AUTH_SECRET", "another-secret-another-secret-another-0123");
    expect(openFlow(cookie, T0.getTime())).toBeNull();
    for (const junk of [undefined, null, "", "x", "a.b", "."]) expect(openFlow(junk)).toBeNull();
  });

  it("refuses to work without a long auth secret", async () => {
    vi.stubEnv("MERGEPORT_AUTH_SECRET", "short");
    await expect(beginOidc(provider(), { origin: ORIGIN })).rejects.toThrow(/MERGEPORT_AUTH_SECRET/);
  });
});

describe("callback checks", () => {
  it("accepts a good round trip and creates a verified user", async () => {
    const r = await login();
    expect(r).toMatchObject({ ok: true, created: true, linked: false, next: "/" });
    const u = await db().user.findUniqueOrThrow({ where: { email: "p@example.com" }, include: { identities: true } });
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(u.githubId).toBeNull();
    expect(u.identities.map((i) => `${i.provider}:${i.subject}`)).toEqual(["oidc:google:sub-1"]);
  });

  it("state mismatch: stops before the provider is contacted", async () => {
    const { cookie } = await beginOidc(provider(), { origin: ORIGIN, now: T0.getTime() });
    const r = await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: callbackFor(cookie, "some-other-state"), cookie, now: T0 });
    expect(r).toEqual({ ok: false, reason: "state" });
    expect(fake.f.seen.exchangeCalls).toBe(0);
    const none = await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: new URL(`${ORIGIN}/auth/oidc/google/callback?code=abc`), cookie, now: T0 });
    expect(none).toEqual({ ok: false, reason: "state" });
    expect(await db().user.count()).toBe(0);
  });

  it("nonce mismatch in the ID token fails even if the library let it through", async () => {
    const r = await login({ nonce: "not-the-nonce-we-sent" });
    expect(r).toEqual({ ok: false, reason: "nonce" });
    const missing = await login({ nonce: undefined });
    expect(missing).toEqual({ ok: false, reason: "nonce" });
    expect(await db().user.count()).toBe(0);
  });

  it("no flow cookie, a cookie for another provider, a tampered or expired one: refused, provider never contacted", async () => {
    const { url, cookie } = await beginOidc(provider(), { origin: ORIGIN, now: T0.getTime() });
    const cb = callbackFor(cookie, url.searchParams.get("state")!);
    expect(await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: cb, cookie: undefined, now: T0 })).toEqual({ ok: false, reason: "flow" });
    const other = sealFlow({ ...openFlow(cookie, T0.getTime())!, p: "microsoft" });
    expect(await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: cb, cookie: other, now: T0 })).toEqual({ ok: false, reason: "flow" });
    expect(await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: cb, cookie: cookie + "x", now: T0 })).toEqual({ ok: false, reason: "flow" });
    expect(await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: cb, cookie, now: new Date(T0.getTime() + 11 * 60_000) })).toEqual({ ok: false, reason: "flow" });
    expect(fake.f.seen.exchangeCalls).toBe(0);
  });

  it("a provider error or a failed code exchange fails closed without leaking the library message", async () => {
    const { url, cookie } = await beginOidc(provider(), { origin: ORIGIN, now: T0.getTime() });
    const denied = new URL(`${ORIGIN}/auth/oidc/google/callback?error=access_denied&state=${url.searchParams.get("state")}`);
    expect(await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: denied, cookie, now: T0 })).toEqual({ ok: false, reason: "provider-error" });
    fake.f.fail = true;
    const r = await completeOidc(db(), provider(), { origin: ORIGIN, callbackUrl: callbackFor(cookie, url.searchParams.get("state")!), cookie, now: T0 });
    expect(r).toEqual({ ok: false, reason: "exchange" });
    expect(JSON.stringify(r)).not.toContain("secret-token-value");
  });

  it("an ID token with no usable subject is refused", async () => {
    expect(await login({ sub: "" })).toEqual({ ok: false, reason: "claims" });
    expect(await login({ sub: 12 as unknown as string })).toEqual({ ok: false, reason: "claims" });
  });

  it("`next` survives only as a relative path", async () => {
    expect(await login(undefined, { next: "/pull-requests" })).toMatchObject({ ok: true, next: "/pull-requests" });
    expect(await login({ sub: "sub-2", email: "q@example.com" }, { next: "//evil.example" })).toMatchObject({ ok: true, next: "/" });
    expect(await login({ sub: "sub-3", email: "r@example.com" }, { next: "https://evil.example" })).toMatchObject({ ok: true, next: "/" });
  });
});

describe("linking rules", () => {
  async function emailUser(email: string) {
    const mailer = new RecordingMailer();
    await requestMagicLink(db(), { email, origin: ORIGIN, mailer, now: T0 });
    const r = await consumeMagicLink(db(), mailer.token(), T0);
    if (!r.ok) throw new Error("link");
    return r.userId;
  }

  it("a verified email that a verified account holds attaches the provider identity to that account", async () => {
    const existing = await emailUser("p@example.com");
    const r = await login();
    expect(r).toMatchObject({ ok: true, userId: existing, created: false, linked: true });
    expect(await db().user.count()).toBe(1);
    expect((await db().identity.findMany({ where: { userId: existing }, orderBy: { provider: "asc" } })).map((i) => i.provider)).toEqual(["email", "oidc:google"]);
  });

  it("email_verified false: a NEW account, the existing one is untouched, the unverified address is not used to link", async () => {
    const existing = await emailUser("p@example.com");
    const r = await login({ email_verified: false });
    expect(r).toMatchObject({ ok: true, created: true, linked: false });
    if (!r.ok) return;
    expect(r.userId).not.toBe(existing);
    const fresh = await db().user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(fresh.email).toBeNull();
    expect(fresh.emailVerifiedAt).toBeNull();
    expect((await db().user.findUniqueOrThrow({ where: { id: existing } })).email).toBe("p@example.com");
    expect((await db().identity.findMany({ where: { userId: r.userId } }))[0].email).toBe("p@example.com"); // kept for display only
  });

  it("email_verified missing (providers like Microsoft) or a non-true value counts as unverified", async () => {
    const existing = await emailUser("p@example.com");
    for (const [i, v] of [undefined, "false", 1, "yes", null].entries()) {
      const r = await login({ sub: `ms-${i}`, email_verified: v as never });
      expect(r).toMatchObject({ ok: true, created: true });
      if (r.ok) expect(r.userId).not.toBe(existing);
    }
    expect((await db().identity.count({ where: { userId: existing } }))).toBe(1);
  });

  it('the string "true" is accepted as verified', async () => {
    const existing = await emailUser("p@example.com");
    expect(await login({ email_verified: "true" })).toMatchObject({ ok: true, userId: existing, linked: true });
  });

  it("an existing account whose email was never verified does not absorb the login: the verified owner gets a new account and the address", async () => {
    const squatter = await db().user.create({ data: { login: "squat", email: "p@example.com", emailVerifiedAt: null } });
    const r = await login();
    expect(r).toMatchObject({ ok: true, created: true, linked: false });
    if (!r.ok) return;
    expect(r.userId).not.toBe(squatter.id);
    expect((await db().user.findUniqueOrThrow({ where: { id: squatter.id } })).email).toBeNull();
    expect((await db().user.findUniqueOrThrow({ where: { id: r.userId } })).email).toBe("p@example.com");
    expect(await db().identity.count({ where: { userId: squatter.id } })).toBe(0);
  });

  it("a legacy GitHub user (no email) is never matched by email", async () => {
    const legacy = await db().user.create({ data: { githubId: 99n, login: "p" } });
    const r = await login();
    expect(r).toMatchObject({ ok: true, created: true });
    if (r.ok) expect(r.userId).not.toBe(legacy.id);
    expect((await db().user.findUniqueOrThrow({ where: { id: legacy.id } })).email).toBeNull();
  });

  it("the provider subject wins on later logins, even when the email changes or becomes unverified", async () => {
    const first = await login();
    const second = await login({ email: "changed@example.com", email_verified: false });
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) expect(second.userId).toBe(first.userId);
    expect(await db().user.count()).toBe(1);
  });

  it("the same subject under two providers is two identities, not one", async () => {
    vi.stubEnv("OIDC_MICROSOFT_ISSUER", "https://login.microsoftonline.com/t/v2.0");
    vi.stubEnv("OIDC_MICROSOFT_CLIENT_ID", "c");
    vi.stubEnv("OIDC_MICROSOFT_CLIENT_SECRET", "d");
    await login({ sub: "same", email_verified: false });
    const ms = findProvider("microsoft")!;
    const { url, cookie } = await beginOidc(ms, { origin: ORIGIN, now: T0.getTime() });
    fake.f.claims = (a) => ({ sub: "same", email_verified: false, nonce: a.nonce });
    await completeOidc(db(), ms, { origin: ORIGIN, callbackUrl: new URL(`${ORIGIN}/auth/oidc/microsoft/callback?code=c&state=${url.searchParams.get("state")}`), cookie, now: T0 });
    expect(await db().user.count()).toBe(2);
  });

  it("two simultaneous first logins of one verified email end in one account", async () => {
    const results = await Promise.all([login(), login({ sub: "sub-9" })]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db().user.count({ where: { email: "p@example.com" } })).toBe(1);
  });
});

describe("the routes", () => {
  it("start sets a signed HttpOnly Lax cookie and redirects to the provider; an unknown provider is 404", async () => {
    const start = (await import("@/app/auth/oidc/[provider]/start/route")).GET;
    const res = await start(request("/auth/oidc/google/start?next=/tasks"), { params: Promise.resolve({ provider: "google" }) });
    expect(res.status).toBe(302);
    expect(locationOf(res).startsWith(ISSUER)).toBe(true);
    const c = state.jar.get(OIDC_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/auth/oidc" });
    expect(openFlow(c.value)?.next).toBe("/tasks");
    expect((await start(request("/auth/oidc/nope/start"), { params: Promise.resolve({ provider: "nope" }) })).status).toBe(404);
  });

  it("callback signs in with a NEW session, clears the flow cookie, and lands on onboarding for a new person", async () => {
    const start = (await import("@/app/auth/oidc/[provider]/start/route")).GET;
    const cb = (await import("@/app/auth/oidc/[provider]/callback/route")).GET;
    const ctx = { params: Promise.resolve({ provider: "google" }) };
    await start(request("/auth/oidc/google/start"), ctx);
    const st = fake.f.seen.authz!.state;
    const res = await cb(request(`/auth/oidc/google/callback?code=abc&state=${st}`), ctx);
    expect(pathOf(res)).toBe("/onboarding");
    expect(state.jar.has(OIDC_COOKIE)).toBe(false);
    const s = await findSession(db(), state.jar.get(SESSION_COOKIE)!.value);
    expect(s?.user.email).toBe("p@example.com");
    expect(state.jar.get(SESSION_COOKIE)!.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true });
    // The flow cookie is single use: replaying the same callback finds no cookie.
    const again = await cb(request(`/auth/oidc/google/callback?code=abc&state=${st}`), ctx);
    expect(pathOf(again)).toBe("/sign-in?error=oidc-flow");
  });

  it("callback with a wrong state goes back to sign-in and creates no session", async () => {
    const start = (await import("@/app/auth/oidc/[provider]/start/route")).GET;
    const cb = (await import("@/app/auth/oidc/[provider]/callback/route")).GET;
    const ctx = { params: Promise.resolve({ provider: "google" }) };
    await start(request("/auth/oidc/google/start"), ctx);
    const res = await cb(request("/auth/oidc/google/callback?code=abc&state=forged"), ctx);
    expect(pathOf(res)).toBe("/sign-in?error=oidc-state");
    expect(await db().session.count()).toBe(0);
  });
});
