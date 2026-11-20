import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, RecordingMailer, formPost, locationOf, pathOf, request, state } from "./auth-mocks";
import { sha256 } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/auth/accounts";
import { ConsoleMailer, MailNotConfiguredError, getMailer, setMailerForTests } from "@/lib/auth/mailer";
import { LIMITS, MAGIC_LINK_TTL_MS, consumeMagicLink, requestMagicLink } from "@/lib/auth/magic-link";
import { SESSION_COOKIE, createSession, findSession } from "@/lib/auth/session";
import { landingPath } from "@/lib/auth/login";

vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const callback = async () => (await import("@/app/auth/magic/callback/route")).GET;
const requestRoute = async () => (await import("@/app/auth/magic/request/route")).POST;

let n = 0;
let mailer: RecordingMailer;
const T0 = new Date(); // routes read the real clock, so the links made here must be valid against it

beforeEach(() => {
  state.db = createTestPrisma(`auth-magic-${n++}`);
  state.jar.clear();
  mailer = new RecordingMailer();
  setMailerForTests(mailer);
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
});
afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const db = () => state.db!;
const ask = (email: string, extra: Partial<Parameters<typeof requestMagicLink>[1]> = {}) => requestMagicLink(db(), { email, origin: ORIGIN, mailer, now: T0, ...extra });

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
  it("emails a 32-byte token, stores only its SHA-256, expires in 15 minutes", async () => {
    expect(await ask("Alice@Example.com")).toBe("sent");
    const token = mailer.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    const rows = await db().magicLink.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].emailLowercased).toBe("alice@example.com");
    expect(rows[0].tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].expiresAt.getTime() - T0.getTime()).toBe(MAGIC_LINK_TTL_MS);
    expect(mailer.sent[0].to).toBe("alice@example.com");
  });

  it("does not tell a known address from an unknown or a throttled one", async () => {
    const post = await requestRoute();
    await ask("known@example.com");
    await consumeMagicLink(db(), mailer.token(), T0);
    const known = await post(formPost("/auth/magic/request", { email: "known@example.com" }));
    const unknown = await post(formPost("/auth/magic/request", { email: "stranger@example.com" }));
    expect(known.status).toBe(303);
    expect(pathOf(known)).toBe("/sign-in?sent=1");
    expect(pathOf(unknown)).toBe(pathOf(known));
    // Burn the per-email budget for a third address, then the next request answers the same way and sends nothing.
    for (let i = 0; i < LIMITS.perEmail; i++) await post(formPost("/auth/magic/request", { email: "busy@example.com" }));
    const before = mailer.sent.length;
    const limited = await post(formPost("/auth/magic/request", { email: "busy@example.com" }));
    expect(pathOf(limited)).toBe(pathOf(known));
    expect(mailer.sent.length).toBe(before);
  });

  it("limits per email, per client address and server-wide, in the database", async () => {
    for (let i = 0; i < LIMITS.perEmail; i++) expect(await ask("a@example.com")).toBe("sent");
    expect(await ask("a@example.com")).toBe("throttled");
    expect(await ask("A@EXAMPLE.COM")).toBe("throttled"); // case does not buy a second budget
    expect(await ask("a+1@example.com")).toBe("sent"); // plus-addressing is a different mailbox

    for (let i = 0; i < LIMITS.perIp; i++) expect(await ask(`ip${i}@example.com`, { ip: "203.0.113.9" })).toBe("sent");
    expect(await ask("another@example.com", { ip: "203.0.113.9" })).toBe("throttled");
    expect(await ask("another@example.com", { ip: "203.0.113.10" })).toBe("sent");

    const keys = (await db().rateLimitState.findMany()).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.every((k) => k.startsWith("auth:"))).toBe(true);
    expect(keys.join()).not.toContain("example.com");
    expect(keys.join()).not.toContain("203.0.113");
  });

  it("counts again after the window passes", async () => {
    for (let i = 0; i < LIMITS.perEmail; i++) await ask("w@example.com");
    expect(await ask("w@example.com")).toBe("throttled");
    expect(await ask("w@example.com", { now: new Date(T0.getTime() + 3600_000 + 1000) })).toBe("sent");
  });

  it("is atomic under concurrency: no more than the limit get through", async () => {
    const results = await Promise.all(Array.from({ length: LIMITS.perEmail + 5 }, () => ask("race@example.com")));
    expect(results.filter((r) => r === "sent")).toHaveLength(LIMITS.perEmail);
  });

  it("rejects a malformed address without writing anything", async () => {
    expect(await ask("not-an-email")).toBe("invalid");
    expect(await db().magicLink.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a cross-site form post (CSRF) and writes nothing", async () => {
    const post = await requestRoute();
    const res = await post(formPost("/auth/magic/request", { email: "v@example.com" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await db().magicLink.count()).toBe(0);
  });

  it("logs neither the address nor the token", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    await ask("private@example.com");
    const token = mailer.token();
    await consumeMagicLink(db(), token, T0);
    const post = await requestRoute();
    await post(formPost("/auth/magic/request", { email: "private@example.com" }));
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("private@example.com");
    expect(logged).not.toContain(token);
  });

  it("a failed delivery reports failure and logs only that fact", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requestMagicLink(db(), { email: "x@example.com", origin: ORIGIN, mailer: { send: async () => { throw new Error("550 x@example.com rejected"); } }, now: T0 });
    expect(r).toBe("send-failed");
    expect(err.mock.calls.join(" ")).not.toContain("x@example.com");
  });
});

describe("opening a link", () => {
  it("signs in, creates the user and identity once, and the link works only once", async () => {
    await ask("New@Example.com");
    const token = mailer.token();
    const first = await consumeMagicLink(db(), token, T0);
    expect(first.ok).toBe(true);
    const user = await db().user.findUniqueOrThrow({ where: { email: "new@example.com" }, include: { identities: true } });
    expect(user.githubId).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.identities.map((i) => `${i.provider}:${i.subject}`)).toEqual(["email:new@example.com"]);
    expect((await consumeMagicLink(db(), token, T0)).ok).toBe(false); // replay
    expect(await db().user.count()).toBe(1);
  });

  it("expires after 15 minutes and a second sign-in finds the same user", async () => {
    await ask("e@example.com");
    const t1 = mailer.token();
    expect((await consumeMagicLink(db(), t1, new Date(T0.getTime() + MAGIC_LINK_TTL_MS + 1000))).ok).toBe(false);
    const r = await consumeMagicLink(db(), t1, new Date(T0.getTime() + MAGIC_LINK_TTL_MS - 1000));
    expect(r.ok).toBe(true);
    await ask("E@example.com", { now: new Date(T0.getTime() + 1000) });
    const r2 = await consumeMagicLink(db(), mailer.token(), new Date(T0.getTime() + 2000));
    expect(r2.ok && r.ok && r2.userId === r.userId).toBe(true);
    expect(await db().user.count()).toBe(1);
    expect(await db().identity.count()).toBe(1);
  });

  it("rejects garbage and unknown tokens", async () => {
    for (const bad of [undefined, null, "", "short", "x".repeat(300), "A".repeat(43)]) expect((await consumeMagicLink(db(), bad, T0)).ok).toBe(false);
  });

  it("plus-addressing and case: one mailbox per exact lowercased address", async () => {
    for (const e of ["a@example.com", "A@Example.com", "a+x@example.com"]) {
      await ask(e);
      await consumeMagicLink(db(), mailer.token(), T0);
    }
    expect((await db().user.findMany({ orderBy: { email: "asc" } })).map((u) => u.email)).toEqual(["a+x@example.com", "a@example.com"]);
  });

  it("leaves a legacy GitHub user alone: no email, no identity, still has its githubId", async () => {
    const legacy = await db().user.create({ data: { githubId: 42n, login: "octo" } });
    await ask("octo@example.com");
    await consumeMagicLink(db(), mailer.token(), T0);
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
    const paths = [pathOf(a), pathOf(b)].sort();
    expect(paths).toEqual(["/onboarding", "/sign-in?error=link-invalid"]);
    expect(await db().session.count()).toBe(1);
    expect(await db().user.count()).toBe(1);
  });

  it("many simultaneous opens still yield one", async () => {
    await ask("many@example.com");
    const token = mailer.token();
    const results = await Promise.all(Array.from({ length: 6 }, () => consumeMagicLink(db(), token, T0)));
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
    await ask("l@example.com");
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
      const r = await consumeMagicLink(db(), mailer.token(), T0);
      if (!r.ok) throw new Error("link");
      const ws = await db().workspace.create({ data: { name: "W" } });
      await db().member.create({ data: { workspaceId: ws.id, userId: r.userId, role: "MEMBER" } });
      await ask(email, { now: new Date(T0.getTime() + 1) });
      return mailer.token();
    };
    const evil = ["//evil.example", "https://evil.example/x", "/\\evil.example", "/\t/evil.example", "/" + String.fromCharCode(13, 10) + "x: y", "javascript:alert(1)", "evil", "///evil.example"];
    for (const [i, next] of evil.entries()) {
      const tok = await member(`n${i}@example.com`);
      const res = await (await callback())(request(`/auth/magic/callback?token=${tok}&next=${encodeURIComponent(next)}`));
      expect(pathOf(res), next).toBe("/");
    }
    const tok = await member("good@example.com");
    const ok = await (await callback())(request(`/auth/magic/callback?token=${tok}&next=${encodeURIComponent("/pull-requests?state=open")}`));
    expect(pathOf(ok)).toBe("/pull-requests?state=open");
  });

  it("sends someone with no workspace to onboarding, and a bad link back to sign-in", async () => {
    await ask("o@example.com");
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${mailer.token()}`)))).toBe("/onboarding");
    expect(pathOf(await (await callback())(request(`/auth/magic/callback?token=${"z".repeat(43)}`)))).toBe("/sign-in?error=link-invalid");
    const u = await db().user.findUniqueOrThrow({ where: { email: "o@example.com" } });
    expect(await landingPath(u.id, "/x")).toBe("/onboarding");
  });
});

describe("mail transport", () => {
  it("development prints the message through the dev transport", async () => {
    setMailerForTests(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SMTP_URL", "");
    const lines: string[] = [];
    const m = getMailer();
    expect(m).toBeInstanceOf(ConsoleMailer);
    await new ConsoleMailer((l) => lines.push(l)).send({ to: "a@b.com", subject: "s", text: "link" });
    expect(lines.join("\n")).toContain("link");
  });

  it("production without SMTP refuses: no console transport, a clear error, and the route says so", async () => {
    setMailerForTests(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_URL", "");
    expect(() => getMailer()).toThrow(MailNotConfiguredError);
    expect(() => new ConsoleMailer()).toThrow(MailNotConfiguredError);
    const log = vi.spyOn(console, "log");
    const res = await (await requestRoute())(formPost("/auth/magic/request", { email: "p@example.com" }));
    expect(pathOf(res)).toBe("/sign-in?error=mail-unconfigured");
    expect(await db().magicLink.count()).toBe(0);
    expect(log).not.toHaveBeenCalled();
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

describe("host", () => {
  it("the test requests use the configured public host", () => {
    expect(request("/x").headers.get("host")).toBe(HOST);
  });
});
