import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, NONCE, ORIGIN, RecordingMailer, formPost, pathOf, request, state, withBrowser } from "./auth-mocks";
import { getAuth } from "@/lib/auth/current";
import { setMailerForTests } from "@/lib/auth/mailer";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { HOSTED_SESSION_DEFAULT_DAYS, RENEW_EVERY_MS, SESSION_COOKIE, SESSION_TTL_MS, createSession, destroyAllSessions, findSession, sessionTtlMs } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveWorkspaceId, selectWorkspace } from "@/lib/authz/active-workspace";
import { activeWorkspaces, createWorkspaceFor } from "@/lib/auth/workspaces";
import { loadViewer } from "@/lib/authz/viewer";
import { ValidationError } from "@/lib/errors";

vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

let n = 0;
const db = () => state.db!;
const T0 = new Date();
let tick = 0;

beforeEach(() => {
  state.db = createTestPrisma(`auth-session-${n++}`);
  state.jar.clear();
  tick = 0;
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
});
afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllEnvs();
});

/** A person who signed in by email link; returns their user id and the cookie token in the jar. */
async function signedIn(email: string) {
  const mailer = new RecordingMailer();
  setMailerForTests(mailer);
  withBrowser();
  await requestMagicLink(db(), { email, origin: ORIGIN, mailer, browserNonce: NONCE, now: new Date(T0.getTime() + tick++ * 61_000) });
  const res = await (await import("@/app/auth/magic/callback/route")).GET(request(`/auth/magic/callback?token=${mailer.token()}`));
  const token = state.jar.get(SESSION_COOKIE)!.value;
  const session = (await findSession(db(), token))!;
  return { userId: session.userId, token, session, res };
}

describe("first sign-in and onboarding", () => {
  it("a new person has a session but no workspace: no viewer, lands on /onboarding", async () => {
    const { res, userId } = await signedIn("new@example.com");
    expect(pathOf(res)).toBe("/onboarding");
    const a = await getAuth();
    expect(a?.user.id).toBe(userId);
    expect(a?.viewer).toBeNull();
    const { requireViewer } = await import("@/lib/auth/current");
    await expect(requireViewer()).rejects.toThrow("REDIRECT /onboarding");
  });

  it("an anonymous visitor is sent to /sign-in", async () => {
    expect(await getAuth()).toBeNull();
    const { requireViewer } = await import("@/lib/auth/current");
    await expect(requireViewer()).rejects.toThrow("REDIRECT /sign-in");
  });

  it("creating a workspace makes the person its ACTIVE ADMIN and binds the session to it", async () => {
    const { userId, session } = await signedIn("owner@example.com");
    const ws = await createWorkspaceFor(db(), userId, "  Acme   engineering ", session.id);
    expect(ws.name).toBe("Acme engineering");
    const m = await db().member.findFirstOrThrow({ where: { workspaceId: ws.id, userId } });
    expect(m).toMatchObject({ role: "OWNER", status: "ACTIVE" });
    expect((await db().session.findUniqueOrThrow({ where: { id: session.id } })).activeWorkspaceId).toBe(ws.id);
    const a = await getAuth();
    expect(a?.viewer).toMatchObject({ workspaceId: ws.id, userId, isAdmin: true, githubId: null });
    expect(await db().teamConfig.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it("rejects an empty or oversized name and creates nothing", async () => {
    const { userId } = await signedIn("v@example.com");
    for (const bad of ["", "   ", undefined, null, "x".repeat(81)]) await expect(createWorkspaceFor(db(), userId, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(await db().workspace.count()).toBe(0);
    expect(await db().member.count()).toBe(0);
  });
});

describe("choosing a workspace", () => {
  async function twoWorkspaces() {
    const p = await signedIn("two@example.com");
    const a = await createWorkspaceFor(db(), p.userId, "Alpha");
    const b = await createWorkspaceFor(db(), p.userId, "Beta");
    return { ...p, a, b };
  }

  it("with several memberships and no choice the oldest is used; selecting one binds the session to it", async () => {
    const { a, b, session, userId } = await twoWorkspaces();
    expect((await getAuth())?.viewer?.workspaceId).toBe(a.id);
    expect(await selectWorkspace(db(), session, b.id)).toBe(true);
    expect((await getAuth())?.viewer?.workspaceId).toBe(b.id);
    expect((await activeWorkspaces(db(), userId)).map((w) => w.name)).toEqual(["Alpha", "Beta"]);
  });

  it("a REVOKED member cannot select that workspace; the session keeps its binding", async () => {
    const { a, b, session, userId } = await twoWorkspaces();
    await selectWorkspace(db(), session, a.id);
    await db().member.updateMany({ where: { workspaceId: b.id, userId }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect(await selectWorkspace(db(), session, b.id)).toBe(false);
    expect((await db().session.findUniqueOrThrow({ where: { id: session.id } })).activeWorkspaceId).toBe(a.id);
    expect((await activeWorkspaces(db(), userId)).map((w) => w.name)).toEqual(["Alpha"]);
    expect(await loadViewer(db(), userId, b.id)).toBeNull();
  });

  it("someone else's workspace and made-up ids cannot be selected", async () => {
    const { session } = await twoWorkspaces();
    const other = await createWorkspaceFor(db(), (await db().user.create({ data: { login: "other", email: "other@example.com" } })).id, "Theirs");
    expect(await selectWorkspace(db(), session, other.id)).toBe(false);
    expect(await selectWorkspace(db(), session, "does-not-exist")).toBe(false);
    expect((await db().session.findUniqueOrThrow({ where: { id: session.id } })).activeWorkspaceId).toBeNull();
  });

  it("a membership revoked AFTER selecting takes effect on the next request", async () => {
    const { a, b, session, userId } = await twoWorkspaces();
    await selectWorkspace(db(), session, b.id);
    expect((await getAuth())?.viewer?.workspaceId).toBe(b.id);
    await db().member.updateMany({ where: { workspaceId: b.id, userId }, data: { status: "REVOKED" } });
    expect((await getAuth())?.viewer?.workspaceId).toBe(a.id); // falls back to a workspace they still belong to
    await db().member.updateMany({ where: { userId }, data: { status: "REVOKED" } });
    expect((await getAuth())?.viewer).toBeNull(); // none left: onboarding again
  });

  it("a session cannot be bound by another person's session id", async () => {
    const x = await signedIn("x@example.com");
    state.jar.clear(); // a second sign-in in the same browser would (rightly) destroy x's session
    const y = await signedIn("y@example.com");
    const wsY = await createWorkspaceFor(db(), y.userId, "Y");
    expect(await selectWorkspace(db(), { id: x.session.id, userId: y.userId }, wsY.id)).toBe(true); // y's membership, but x's session row:
    expect((await db().session.findUniqueOrThrow({ where: { id: x.session.id } })).activeWorkspaceId).toBeNull(); // the update is scoped to the session's own user
  });

  it("the old mp_ws cookie still works for sessions without a binding, and is still validated", async () => {
    const { a, b, userId } = await twoWorkspaces();
    expect(await resolveActiveWorkspaceId(db(), { id: userId }, b.id)).toBe(b.id);
    expect(await resolveActiveWorkspaceId(db(), { id: userId }, "forged")).toBe(a.id);
    state.jar.set(WORKSPACE_COOKIE, { value: b.id, options: {} });
    expect((await getAuth())?.viewer?.workspaceId).toBe(b.id);
  });
});

describe("sign-out and session lifetime", () => {
  it("sign-out deletes the server-side session: the old cookie value stops working", async () => {
    const { token } = await signedIn("out@example.com");
    expect(await findSession(db(), token)).not.toBeNull();
    const res = await (await import("@/app/auth/signout/route")).POST(formPost("/auth/signout", {}));
    expect(pathOf(res)).toBe("/sign-in");
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await findSession(db(), token)).toBeNull();
    expect(await db().session.count()).toBe(0);
  });

  it("a cross-site sign-out post is refused and the session survives", async () => {
    const { token } = await signedIn("keep@example.com");
    const res = await (await import("@/app/auth/signout/route")).POST(formPost("/auth/signout", {}, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await findSession(db(), token)).not.toBeNull();
  });

  it("a session past its expiry is not accepted, and a cookie value is only ever the preimage of the stored hash", async () => {
    const u = await db().user.create({ data: { login: "t", email: "t@example.com" } });
    const s = await createSession(db(), u.id, T0);
    expect(sessionTtlMs()).toBe(HOSTED_SESSION_DEFAULT_DAYS * 24 * 3600_000);
    const s2 = await createSession(db(), u.id, T0);
    expect(await findSession(db(), s.token, new Date(T0.getTime() + sessionTtlMs() - 1000))).not.toBeNull();
    expect(await findSession(db(), s2.token, new Date(T0.getTime() + sessionTtlMs() + 1000))).toBeNull(); // never used, so never slid
    expect((await db().session.findFirstOrThrow()).tokenHash).not.toBe(s.token);
  });

  it("two browsers are two sessions: signing out of one leaves the other", async () => {
    const first = await signedIn("multi@example.com");
    state.jar.clear();
    const second = await signedIn("multi@example.com");
    expect(second.userId).toBe(first.userId);
    expect(second.token).not.toBe(first.token);
    await (await import("@/app/auth/signout/route")).POST(formPost("/auth/signout", {}));
    expect(await findSession(db(), first.token)).not.toBeNull();
    expect(await findSession(db(), second.token)).toBeNull();
  });
});

describe("the host guard", () => {
  const at = async (host: string, init: { method?: string; origin?: string } = {}) => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(`https://${host}/sign-in`, { method: init.method ?? "GET", headers: { host, ...(init.origin ? { origin: init.origin } : {}) } }));
  };

  it("a hosted deployment answers on its public host only; a state-changing request needs the same origin", async () => {
    expect((await at(HOST)).status).toBe(200);
    expect((await at("127.0.0.1:3000")).status).toBe(403); // a proxy can forward a client's own Host header: loopback is no proof of a local caller
    expect((await at("evil.example")).status).toBe(403);
    expect((await at(HOST, { method: "POST", origin: ORIGIN })).status).toBe(200);
    expect((await at(HOST, { method: "POST", origin: "https://evil.example" })).status).toBe(403);
  });

  it("without MERGEPORT_PUBLIC_URL the public name is refused like any other", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await at(HOST)).status).toBe(403);
  });
});

describe("sliding hosted sessions", () => {
  const DAY = 24 * 3600_000;

  it("defaults to 30 days, MERGEPORT_SESSION_DAYS overrides (1 to 180), the local app keeps 180", () => {
    expect(sessionTtlMs()).toBe(30 * DAY);
    vi.stubEnv("MERGEPORT_SESSION_DAYS", "7");
    expect(sessionTtlMs()).toBe(7 * DAY);
    for (const bad of ["0", "181", "abc", "-3", "1.5x"]) {
      vi.stubEnv("MERGEPORT_SESSION_DAYS", bad);
      expect(sessionTtlMs()).toBe(30 * DAY);
    }
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect(sessionTtlMs()).toBe(SESSION_TTL_MS);
  });

  it("renews a session in use at most once an hour, and an idle one expires", async () => {
    const u = await db().user.create({ data: { login: "s", email: "s@example.com" } });
    const s = await createSession(db(), u.id, T0);
    const row = async () => (await db().session.findFirstOrThrow()).expiresAt.getTime();
    expect(await row()).toBe(T0.getTime() + 30 * DAY);
    await findSession(db(), s.token, new Date(T0.getTime() + RENEW_EVERY_MS - 1000)); // under an hour: no write
    expect(await row()).toBe(T0.getTime() + 30 * DAY);
    const later = new Date(T0.getTime() + RENEW_EVERY_MS + 1000);
    const renewed = await findSession(db(), s.token, later);
    expect(await row()).toBe(later.getTime() + 30 * DAY);
    expect(renewed?.expiresAt.getTime()).toBe(later.getTime() + 30 * DAY);
    await findSession(db(), s.token, new Date(later.getTime() + 1000)); // again within the hour: unchanged
    expect(await row()).toBe(later.getTime() + 30 * DAY);
    // Used every few days it never expires; left alone for 30 days it does.
    const ten = new Date(T0.getTime() + 10 * DAY);
    expect(await findSession(db(), s.token, ten)).not.toBeNull();
    expect(await findSession(db(), s.token, new Date(ten.getTime() + 31 * DAY))).toBeNull();
  });

  it("never lasts past 180 days from sign-in however often it is used", async () => {
    const u = await db().user.create({ data: { login: "cap", email: "cap@example.com" } });
    const s = await createSession(db(), u.id, T0);
    for (let d = 20; d <= 175; d += 20) expect(await findSession(db(), s.token, new Date(T0.getTime() + d * DAY))).not.toBeNull();
    const row = await db().session.findFirstOrThrow();
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.createdAt.getTime() + SESSION_TTL_MS);
    expect(await findSession(db(), s.token, new Date(row.createdAt.getTime() + SESSION_TTL_MS + 1000))).toBeNull();
  });

  it("the local app's sessions are not slid", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const u = await db().user.create({ data: { login: "l", githubId: 5n } });
    const s = await createSession(db(), u.id, T0);
    await findSession(db(), s.token, new Date(T0.getTime() + 5 * DAY));
    expect((await db().session.findFirstOrThrow()).expiresAt.getTime()).toBe(T0.getTime() + SESSION_TTL_MS);
  });
});

describe("sign out everywhere", () => {
  it("deletes every session of the person on every device and none of anyone else's; the action ends at sign-in", async () => {
    const mine1 = await signedIn("all@example.com");
    state.jar.clear();
    const mine2 = await signedIn("all@example.com");
    state.jar.clear();
    const other = await signedIn("other@example.com");
    state.jar.set(SESSION_COOKIE, { value: mine2.token, options: {} });
    const { signOutEverywhereAction } = await import("@/app/account-actions");
    await expect(signOutEverywhereAction()).rejects.toThrow("REDIRECT /sign-in");
    expect(await findSession(db(), mine1.token)).toBeNull();
    expect(await findSession(db(), mine2.token)).toBeNull();
    expect(await findSession(db(), other.token)).not.toBeNull();
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await destroyAllSessions(db(), other.userId)).toBe(1);
  });

  it("does nothing without a session", async () => {
    const { signOutEverywhereAction } = await import("@/app/account-actions");
    await expect(signOutEverywhereAction()).rejects.toThrow("REDIRECT /sign-in");
  });
});
