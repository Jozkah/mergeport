import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, RecordingMailer, formPost, pathOf, request, state } from "./auth-mocks";
import { getAuth } from "@/lib/auth/current";
import { setMailerForTests } from "@/lib/auth/mailer";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, findSession } from "@/lib/auth/session";
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

beforeEach(() => {
  state.db = createTestPrisma(`auth-session-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
});
afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllEnvs();
});

/** A person who signed in by email link; returns their user id and the cookie token in the jar. */
async function signedIn(email: string) {
  const mailer = new RecordingMailer();
  setMailerForTests(mailer);
  await requestMagicLink(db(), { email, origin: ORIGIN, mailer, now: T0 });
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
    expect(m).toMatchObject({ role: "ADMIN", status: "ACTIVE" });
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
    expect(await findSession(db(), s.token, new Date(T0.getTime() + SESSION_TTL_MS - 1000))).not.toBeNull();
    expect(await findSession(db(), s.token, new Date(T0.getTime() + SESSION_TTL_MS + 1000))).toBeNull();
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

  it("a hosted deployment answers on its public host and loopback only; a state-changing request needs the same origin", async () => {
    expect((await at(HOST)).status).toBe(200);
    expect((await at("127.0.0.1:3000")).status).toBe(200);
    expect((await at("evil.example")).status).toBe(403);
    expect((await at(HOST, { method: "POST", origin: ORIGIN })).status).toBe(200);
    expect((await at(HOST, { method: "POST", origin: "https://evil.example" })).status).toBe(403);
  });

  it("without MERGEPORT_PUBLIC_URL the public name is refused like any other", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await at(HOST)).status).toBe(403);
  });
});
