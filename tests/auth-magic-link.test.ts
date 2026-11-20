import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { NONCE, ORIGIN, RecordingMailer, formPost, locationOf, pathOf, request, state, withBrowser } from "./auth-mocks";
import { sha256 } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/auth/accounts";
import { clientIp, hostedConfigProblems } from "@/lib/auth/hosted-config";
import { ConsoleMailer, MailNotConfiguredError, getMailer, setMailerForTests } from "@/lib/auth/mailer";
import { LIMITS, MAGIC_COOKIE, MAGIC_LINK_TTL_MS, consumeMagicLink, requestMagicLink } from "@/lib/auth/magic-link";
import { SESSION_COOKIE, createSession, findSession } from "@/lib/auth/session";
import { landingPath } from "@/lib/auth/login";

vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const callback = async () => (await import("@/app/auth/magic/callback/route")).GET;
const requestRoute = async () => (await import("@/app/auth/magic/request/route")).POST;

let n = 0;
let mailer: RecordingMailer;
let tick = 0;
const T0 = new Date(); // routes read the real clock, so the links made here must be valid against it
const MIN = 60_000;

beforeEach(() => {
  state.db = createTestPrisma(`auth-magic-${n++}`);
  state.jar.clear();
  withBrowser();
  tick = 0;
  mailer = new RecordingMailer();
  setMailerForTests(mailer);
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
});
afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const db = () => state.db!;
/** Each call is a minute later than the last unless a time is given, so the per-address spacing never gets in the way of tests about other things. */
const ask = (email: string, extra: Partial<Parameters<typeof requestMagicLink>[1]> = {}) =>
  requestMagicLink(db(), { email, origin: ORIGIN, mailer, browserNonce: NONCE, now: new Date(T0.getTime() + tick++ * 61_000), ...extra });
const open = (token: string, now = T0, nonce: string | null = NONCE) => consumeMagicLink(db(), token, nonce, now);
const post = async (email: string, ip = "198.51.100.7") => (await requestRoute())(formPost("/auth/magic/request", { email }, { "x-forwarded-for": ip }));

describe("email normalization", () => {
  it("lowercases and trims, keeps plus-addressing, rejects what is not an address", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("alice+work@example.com")).toBe("alice+work@example.com");
    expect(normalizeEmail("a+b@x.com")).not.toBe(normalizeEmail("a@x.com"));
    for (const bad of ["", "nope", "a@b", "a@@b.com", "a b@c.com", "a@b.com\nbcc:evil@x.com", "<a>@b.com", ".a@b.com", "a..b@c.com", "a@-b.com", 5, null]) expect(normalizeEmail(bad)).toBeNull();
    expect(normalizeEmail("x".repeat(250) + "@b.com")).toBeNull();
  });
});

describe("requesting a link", () => {
  it("emails a 32-byte token, stores only its SHA-256 (and the browser value's), expires in 15 minutes", async () => {
    expect(await ask("Alice@Example.com", { now: T0 })).toBe("sent");
    const token = mailer.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    const rows = await db().magicLink.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].emailLowercased).toBe("alice@example.com");
    expect(rows[0].tokenHash).toBe(sha256(token));
    expect(rows[0].browserHash).toBe(sha256(NONCE));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(NONCE);
    expect(rows[0].expiresAt.getTime() - T0.getTime()).toBe(MAGIC_LINK_TTL_MS);
    expect(mailer.sent[0].to).toBe("alice@example.com");
  });

  it("does not tell a known address from an unknown or a throttled one", async () => {
    await ask("known@example.com");
    await open(mailer.token());
    const known = await post("known@example.com", "198.51.100.1");
    const unknown = await post("stranger@example.com", "198.51.100.2");
    expect(known.status).toBe(303);
    expect(pathOf(known)).toBe("/sign-in?sent=1");
    expect(pathOf(unknown)).toBe(pathOf(known));
    await post("busy@example.com", "198.51.100.3");
    const before = mailer.sent.length;
    const limited = await post("busy@example.com", "198.51.100.3"); // inside the per-address spacing
    expect(pathOf(limited)).toBe(pathOf(known));
    expect(limited.headers.get("set-cookie")).toBe(known.headers.get("set-cookie"));
    expect(mailer.sent.length).toBe(before);
  });

  it("rejects a malformed address without writing anything", async () => {
    expect(await ask("not-an-email")).toBe("invalid");
    expect(await db().magicLink.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a cross-site form post (CSRF) and writes nothing", async () => {
    const res = await (await requestRoute())(formPost("/auth/magic/request", { email: "v@example.com" }, { origin: "https://evil.example", "x-forwarded-for": "198.51.100.7" }));
    expect(res.status).toBe(403);
    expect(await db().magicLink.count()).toBe(0);
  });

  it("logs neither the address nor the token", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    await ask("private@example.com");
    const token = mailer.token();
    await open(token);
    await post("private@example.com");
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("private@example.com");
    expect(logged).not.toContain(token);
  });

  it("a failed delivery reports failure and logs only that fact", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requestMagicLink(db(), { email: "x@example.com", origin: ORIGIN, browserNonce: NONCE, mailer: { send: async () => { throw new Error("550 x@example.com rejected"); } }, now: T0 });
    expect(r).toBe("send-failed");
    expect(err.mock.calls.join(" ")).not.toContain("x@example.com");
  });
});

describe("rate limits (lockout and email bombing)", () => {
  it("one mail per address per minute, whoever asks; a refused call does not move the slot", async () => {
    expect(await ask("m@example.com", { now: T0, ip: "203.0.113.1" })).toBe("sent");
    expect(await ask("m@example.com", { now: new Date(T0.getTime() + 20_000), ip: "203.0.113.2" })).toBe("throttled");
    expect(await ask("m@example.com", { now: new Date(T0.getTime() + 59_000), ip: "203.0.113.3" })).toBe("throttled");
    expect(await ask("m@example.com", { now: new Date(T0.getTime() + MIN), ip: "203.0.113.4" })).toBe("sent"); // exactly one minute after the one that went through
    expect(mailer.sent).toHaveLength(2);
  });

  it("bombing: fifty clients asking for one victim in the same minute produce ONE mail", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => ask("victim@example.com", { now: T0, ip: `203.0.113.${i + 1}` })));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("lockout: an attacker exhausting THEIR budget for an address does not stop the victim from another address", async () => {
    for (let i = 0; i < LIMITS.perEmailIp; i++) expect(await ask("victim@example.com", { ip: "203.0.113.66" })).toBe("sent");
    expect(await ask("victim@example.com", { ip: "203.0.113.66" })).toBe("throttled"); // the attacker is cut off for this address
    expect(mailer.sent).toHaveLength(LIMITS.perEmailIp);
    expect(await ask("victim@example.com", { ip: "198.51.100.20" })).toBe("sent"); // the victim, from their own address, minutes later
    expect(mailer.sent).toHaveLength(LIMITS.perEmailIp + 1);
    expect(mailer.sent.at(-1)!.to).toBe("victim@example.com");
  });

  it("a legitimate request one minute after an attacker's still gets its mail (no lasting block)", async () => {
    await ask("v2@example.com", { now: T0, ip: "203.0.113.66" });
    for (let i = 0; i < 40; i++) await ask("v2@example.com", { now: new Date(T0.getTime() + 1000 + i * 1000), ip: "203.0.113.66" }); // 40 refused attempts
    expect(await ask("v2@example.com", { now: new Date(T0.getTime() + MIN + 1), ip: "198.51.100.20" })).toBe("sent");
  });

  it("refused calls are not counted: hammering a full bucket changes nothing", async () => {
    for (let i = 0; i < LIMITS.perEmailIp; i++) await ask("full@example.com", { ip: "203.0.113.9" });
    const key = `auth:ml:ei:${sha256("full@example.com|203.0.113.9")}`;
    const before = await db().rateLimitState.findUniqueOrThrow({ where: { key } });
    for (let i = 0; i < 30; i++) await ask("full@example.com", { ip: "203.0.113.9" });
    const after = await db().rateLimitState.findUniqueOrThrow({ where: { key } });
    expect(after.remaining).toBe(before.remaining);
    expect(after.resetAt.getTime()).toBe(before.resetAt.getTime());
  });

  it("random addresses from one client cannot use up the server-wide budget: the client limit stops first and the global bucket is not touched by refused calls", async () => {
    for (let i = 0; i < LIMITS.perIp; i++) expect(await ask(`r${i}@example.com`, { now: T0, ip: "203.0.113.5" })).toBe("sent");
    for (let i = 0; i < 300; i++) expect(await ask(`s${i}@example.com`, { now: T0, ip: "203.0.113.5" })).toBe("throttled");
    const g = await db().rateLimitState.findUniqueOrThrow({ where: { key: "auth:ml:all" } });
    expect(g.limit - g.remaining).toBe(LIMITS.perIp);
    expect(await ask("honest@example.com", { now: T0, ip: "198.51.100.30" })).toBe("sent"); // everyone else is unaffected
  });

  it("windows reopen: the per-client budget counts again an hour later", async () => {
    for (let i = 0; i < LIMITS.perEmailIp; i++) await ask("w@example.com", { ip: "203.0.113.7" });
    expect(await ask("w@example.com", { ip: "203.0.113.7" })).toBe("throttled");
    expect(await ask("w@example.com", { ip: "203.0.113.7", now: new Date(T0.getTime() + 3 * 3600_000) })).toBe("sent");
  });

  it("is atomic under concurrency: no more than the per-client limit get through", async () => {
    const results = await Promise.all(Array.from({ length: LIMITS.perIp + 10 }, (_, i) => ask(`c${i}@example.com`, { now: T0, ip: "203.0.113.8" })));
    expect(results.filter((r) => r === "sent")).toHaveLength(LIMITS.perIp);
  });

  it("keeps hashes, not addresses, in its keys", async () => {
    await ask("someone@example.com", { ip: "203.0.113.9" });
    const keys = (await db().rateLimitState.findMany()).map((r) => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(keys.every((k) => k.startsWith("auth:"))).toBe(true);
    expect(keys.join()).not.toContain("example.com");
    expect(keys.join()).not.toContain("203.0.113");
  });
});

describe("hosted needs a trusted client address", () => {
  it("reports what is missing, and the request route refuses (503, nothing written) until it is set", async () => {
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "");
    expect(hostedConfigProblems().join()).toMatch(/MERGEPORT_TRUST_PROXY=true/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await (await requestRoute())(formPost("/auth/magic/request", { email: "a@example.com" }, { "x-forwarded-for": "198.51.100.7" }));
    expect(res.status).toBe(503);
    expect(await db().magicLink.count()).toBe(0);
    expect(err).toHaveBeenCalled();
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
    expect(hostedConfigProblems()).toEqual([]);
  });

  it("the start-up check throws with the same list", async () => {
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "");
    const { assertHostedConfig } = await import("@/lib/auth/hosted-config");
    expect(() => assertHostedConfig()).toThrow(/MERGEPORT_TRUST_PROXY/);
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect(() => assertHostedConfig()).not.toThrow(); // the local app has no such requirement
  });

  it("refuses when the proxy sent no client address", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await (await requestRoute())(formPost("/auth/magic/request", { email: "a@example.com" }));
    expect(res.status).toBe(503);
  });

  it("takes the address from the RIGHT of X-Forwarded-For (the trusted proxy's entry), never the client-supplied left side", () => {
    const req = (xff: string) => new Request(ORIGIN, { headers: { "x-forwarded-for": xff } });
    expect(clientIp(req("6.6.6.6, 198.51.100.7"))).toBe("198.51.100.7");
    expect(clientIp(req("198.51.100.7"))).toBe("198.51.100.7");
    vi.stubEnv("MERGEPORT_TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(req("6.6.6.6, 198.51.100.7, 10.0.0.2"))).toBe("198.51.100.7");
    expect(clientIp(req("198.51.100.7"))).toBeNull(); // fewer entries than trusted hops: not trustworthy
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "");
    expect(clientIp(req("198.51.100.7, 10.0.0.2"))).toBeNull();
  });

  it("the route limits on the trusted address, so a forged left entry buys nothing", async () => {
    for (let i = 0; i < LIMITS.perIp; i++) await (await requestRoute())(formPost("/auth/magic/request", { email: `f${i}@example.com` }, { "x-forwarded-for": `1.1.1.${i}, 198.51.100.9` }));
    const before = mailer.sent.length;
    await (await requestRoute())(formPost("/auth/magic/request", { email: "one-more@example.com" }, { "x-forwarded-for": "2.2.2.2, 198.51.100.9" }));
    expect(before).toBe(LIMITS.perIp);
    expect(mailer.sent.length).toBe(before);
    expect((await db().magicLink.findFirstOrThrow()).ipHash).toBe(sha256("ip:198.51.100.9"));
  });
});

describe("the link is bound to the browser that asked", () => {
  it("opened in another browser (no cookie) or with a wrong value: nothing is consumed, the right browser can still use it", async () => {
    await ask("b@example.com");
    const token = mailer.token();
    expect(await open(token, T0, null)).toEqual({ ok: false, reason: "browser" });
    expect(await open(token, T0, "some-other-browser-value-0123456")).toEqual({ ok: false, reason: "browser" });
    expect((await db().magicLink.findFirstOrThrow()).consumedAt).toBeNull();
    expect(await db().user.count()).toBe(0);
    expect((await open(token)).ok).toBe(true);
  });

  it("a link with no stored browser value (never bound) is refused", async () => {
    await db().magicLink.create({ data: { emailLowercased: "old@example.com", tokenHash: sha256("t".repeat(43)), expiresAt: new Date(T0.getTime() + MIN) } });
    expect(await open("t".repeat(43))).toEqual({ ok: false, reason: "browser" });
  });

  it("the request route sets an HttpOnly Lax cookie scoped to /auth/magic, reuses it for a second request, and the callback needs it", async () => {
    state.jar.clear();
    await post("c1@example.com", "198.51.100.1");
    const c = state.jar.get(MAGIC_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/auth/magic", maxAge: 900 });
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    await post("c2@example.com", "198.51.100.2");
    expect(state.jar.get(MAGIC_COOKIE)!.value).toBe(c.value); // one value per browser: the first link is not orphaned
    const t1 = mailer.token(0);
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${t1}`)))).toBe("/onboarding");
  });

  it("a mail scanner or a victim's other browser gets a friendly page and does not burn the link", async () => {
    await post("s@example.com");
    const token = mailer.token();
    const mine = state.jar.get(MAGIC_COOKIE)!.value;
    state.jar.clear(); // the scanner, or a browser the attacker lured the victim into, has no cookie
    const res = await (await callback())(request(`/auth/magic/callback?token=${token}`));
    expect(pathOf(res)).toBe("/sign-in?error=link-browser");
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await db().session.count()).toBe(0);
    state.jar.set(MAGIC_COOKIE, { value: mine, options: {} });
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${token}`)))).toBe("/onboarding"); // still usable where it was asked
    expect(state.jar.has(MAGIC_COOKIE)).toBe(false); // spent with the link
  });

  it("login CSRF: a link requested by an attacker does not sign the victim's browser in as the attacker", async () => {
    await ask("attacker@example.com", { browserNonce: "attacker-browser-value-0123456789" });
    state.jar.clear();
    withBrowser("victim-browser-value-0123456789ab");
    const res = await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`));
    expect(pathOf(res)).toBe("/sign-in?error=link-browser");
    expect(await db().session.count()).toBe(0);
  });
});

describe("opening a link", () => {
  it("signs in, creates the user and identity once, and the link works only once", async () => {
    await ask("New@Example.com");
    const token = mailer.token();
    const first = await open(token);
    expect(first.ok).toBe(true);
    const user = await db().user.findUniqueOrThrow({ where: { email: "new@example.com" }, include: { identities: true } });
    expect(user.githubId).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.identities.map((i) => `${i.provider}:${i.subject}`)).toEqual(["email:new@example.com"]);
    expect((await open(token)).ok).toBe(false); // replay
    expect(await db().user.count()).toBe(1);
  });

  it("expires after 15 minutes and a second sign-in finds the same user", async () => {
    await ask("e@example.com", { now: T0 });
    const t1 = mailer.token();
    expect((await open(t1, new Date(T0.getTime() + MAGIC_LINK_TTL_MS + 1000))).ok).toBe(false);
    const r = await open(t1, new Date(T0.getTime() + MAGIC_LINK_TTL_MS - 1000));
    expect(r.ok).toBe(true);
    await ask("E@example.com", { now: new Date(T0.getTime() + MIN + 1000) });
    const r2 = await open(mailer.token(), new Date(T0.getTime() + 2 * MIN));
    expect(r2.ok && r.ok && r2.userId === r.userId).toBe(true);
    expect(await db().user.count()).toBe(1);
    expect(await db().identity.count()).toBe(1);
  });

  it("rejects garbage and unknown tokens", async () => {
    for (const bad of [undefined, null, "", "short", "x".repeat(300), "A".repeat(43)]) expect((await open(bad as string)).ok).toBe(false);
  });

  it("plus-addressing and case: one mailbox per exact lowercased address", async () => {
    for (const e of ["a@example.com", "A@Example.com", "a+x@example.com"]) {
      await ask(e);
      await open(mailer.token());
    }
    expect((await db().user.findMany({ orderBy: { email: "asc" } })).map((u) => u.email)).toEqual(["a+x@example.com", "a@example.com"]);
  });

  it("leaves a legacy GitHub user alone: no email, no identity, still has its githubId", async () => {
    const legacy = await db().user.create({ data: { githubId: 42n, login: "octo" } });
    await ask("octo@example.com");
    await open(mailer.token());
    const after = await db().user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.email).toBeNull();
    expect(after.githubId).toBe(42n);
    expect(await db().user.count()).toBe(2);
  });

  it("two simultaneous opens of one link give exactly one session", async () => {
    await ask("twice@example.com");
    const token = mailer.token();
    const get = await callback();
    const url = `/auth/magic/callback?token=${token}`;
    const [a, b] = await Promise.all([get(request(url)), get(request(url))]);
    expect([pathOf(a), pathOf(b)].sort()).toEqual(["/onboarding", "/sign-in?error=link-invalid"]);
    expect(await db().session.count()).toBe(1);
    expect(await db().user.count()).toBe(1);
  });

  it("many simultaneous opens still yield one", async () => {
    await ask("many@example.com");
    const token = mailer.token();
    const results = await Promise.all(Array.from({ length: 6 }, () => open(token)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db().user.count()).toBe(1);
  });
});

describe("the callback route", () => {
  it("sets an HttpOnly, SameSite=Lax, Secure cookie holding a token whose hash is the session row", async () => {
    await ask("c@example.com");
    const res = await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`));
    expect(res.status).toBe(303);
    const c = state.jar.get(SESSION_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    const s = await findSession(db(), c.value);
    expect(s?.user.email).toBe("c@example.com");
    expect(await db().session.count({ where: { tokenHash: sha256(c.value) } })).toBe(1);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("is not Secure on plain http loopback (no public https address)", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "http://127.0.0.1:3000");
    await ask("l@example.com", { origin: "http://127.0.0.1:3000" });
    const res = await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`, { headers: { host: "127.0.0.1:3000" } }));
    expect(state.jar.get(SESSION_COOKIE)!.options.secure).toBe(false);
    expect(locationOf(res).startsWith("http://127.0.0.1:3000/")).toBe(true);
  });

  it("starts a NEW session and destroys the one the browser arrived with (fixation)", async () => {
    const stranger = await db().user.create({ data: { githubId: 7n, login: "someone" } });
    const planted = await createSession(db(), stranger.id);
    state.jar.set(SESSION_COOKIE, { value: planted.token, options: {} });
    await ask("f@example.com");
    await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`));
    const now = state.jar.get(SESSION_COOKIE)!.value;
    expect(now).not.toBe(planted.token);
    expect(await findSession(db(), planted.token)).toBeNull();
    expect((await findSession(db(), now))?.user.email).toBe("f@example.com");
  });

  it("keeps `next` only when it is a relative path", async () => {
    const member = async (email: string) => {
      await ask(email);
      const r = await open(mailer.token());
      if (!r.ok) throw new Error("link");
      const ws = await db().workspace.create({ data: { name: "W" } });
      await db().member.create({ data: { workspaceId: ws.id, userId: r.userId, role: "MEMBER" } });
      await ask(email);
      return mailer.token();
    };
    const evil = ["//evil.example", "https://evil.example/x", "/\\evil.example", "/\t/evil.example", "/" + String.fromCharCode(13, 10) + "x: y", "javascript:alert(1)", "evil", "///evil.example"];
    for (const [i, next] of evil.entries()) {
      const tok = await member(`n${i}@example.com`);
      const res = await (await callback())(request(`/auth/magic/callback?token=${tok}&next=${encodeURIComponent(next)}`));
      expect(pathOf(res), next).toBe("/");
      withBrowser();
    }
    const tok = await member("good@example.com");
    const ok = await (await callback())(request(`/auth/magic/callback?token=${tok}&next=${encodeURIComponent("/pull-requests?state=open")}`));
    expect(pathOf(ok)).toBe("/pull-requests?state=open");
  });

  it("sends someone with no workspace to onboarding, and a bad link back to sign-in", async () => {
    await ask("o@example.com");
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`)))).toBe("/onboarding");
    withBrowser();
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${"z".repeat(43)}`)))).toBe("/sign-in?error=link-invalid");
    const u = await db().user.findUniqueOrThrow({ where: { email: "o@example.com" } });
    expect(await landingPath(u.id, "/x")).toBe("/onboarding");
  });
});

describe("cleanup", () => {
  it("has an index on expiresAt and removes links that expired a day ago (at most once a minute per process)", async () => {
    const idx = await db().$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'MagicLink'`;
    expect(idx.map((i) => i.indexname)).toContain("MagicLink_expiresAt_idx");
    await db().magicLink.create({ data: { emailLowercased: "stale@example.com", tokenHash: "stale", expiresAt: new Date(Date.now() - 3 * 24 * 3600_000) } });
    await ask("fresh@example.com", { now: new Date() });
    // The first request of the process may skip cleanup if another test in this file already ran it within the minute; a later call after the minute does it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    await ask("fresh2@example.com", { now: new Date() });
    vi.useRealTimers();
    expect(await db().magicLink.count({ where: { tokenHash: "stale" } })).toBe(0);
  });
});

describe("mail transport", () => {
  it("development (not https) prints the message through the dev transport", async () => {
    setMailerForTests(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SMTP_URL", "");
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "http://127.0.0.1:3000");
    const lines: string[] = [];
    expect(getMailer()).toBeInstanceOf(ConsoleMailer);
    await new ConsoleMailer((l) => lines.push(l)).send({ to: "a@b.com", subject: "s", text: "link" });
    expect(lines.join("\n")).toContain("link");
  });

  it("an https hosted deployment never uses the console transport, even outside production", async () => {
    setMailerForTests(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SMTP_URL", "");
    expect(() => getMailer()).toThrow(MailNotConfiguredError);
    expect(() => new ConsoleMailer()).toThrow(MailNotConfiguredError);
    const log = vi.spyOn(console, "log");
    const res = await post("p@example.com");
    expect(pathOf(res)).toBe("/sign-in?error=mail-unconfigured");
    expect(await db().magicLink.count()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("production without SMTP refuses on any address", async () => {
    setMailerForTests(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_URL", "");
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "http://127.0.0.1:3000");
    expect(() => getMailer()).toThrow(MailNotConfiguredError);
    expect(() => new ConsoleMailer()).toThrow(MailNotConfiguredError);
  });

  it("SMTP_URL without MAIL_FROM is also a configuration error", () => {
    setMailerForTests(null);
    vi.stubEnv("SMTP_URL", "smtp://user:pass@mail.example:587");
    vi.stubEnv("MAIL_FROM", "");
    expect(() => getMailer()).toThrow(/MAIL_FROM/);
    vi.stubEnv("MAIL_FROM", "Mergeport <no-reply@example.com>");
    expect(() => getMailer()).not.toThrow();
  });
});
