import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, RecordingMailer, state } from "./auth-mocks";
import { tokenOf, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { createInvitation } from "@/lib/services/invitations";

/** Server-rendered pages that decide what a person sees from who they are: the invitation page branches and the onboarding invitation list. */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
beforeEach(() => {
  state.db = createTestPrisma(`ui-pages-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});
const db = () => state.db!;

/** Every string in a rendered element tree (types, owners and database handles skipped). */
function text(el: unknown): string {
  const seen = new WeakSet<object>();
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") return void out.push(v);
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      if (k === "type" || k === "_owner" || k === "_store" || k === "db") continue;
      out.push(k);
      walk(x);
    }
  };
  walk(el);
  return out.join(" ").toLowerCase();
}

async function invitedPerson(opts: { email: string; verified: boolean; signedIn: boolean }) {
  const w = await workspaceWithOwner(db(), "boss@example.com", "Acme Co");
  const mailer = new RecordingMailer();
  await createInvitation(db(), w.viewer, { email: "ivy@example.com", role: "MEMBER", mailer, origin: ORIGIN });
  const token = tokenOf(mailer);
  if (opts.signedIn) {
    const user = await db().user.create({ data: { login: opts.email.split("@")[0], email: opts.email, emailVerifiedAt: opts.verified ? new Date() : null } });
    const { token: session } = await createSession(db(), user.id, new Date());
    state.jar.set(SESSION_COOKIE, { value: session, options: {} });
  }
  return { token, w };
}

describe("the invitation page", () => {
  const render = async (token: string) => text(await (await import("@/app/invite/[token]/page")).default({ params: Promise.resolve({ token }) }));

  it("a signed-in person whose address matches but is not confirmed is told to confirm it, not that the address differs", async () => {
    const { token } = await invitedPerson({ email: "ivy@example.com", verified: false, signedIn: true });
    const t = await render(token);
    expect(t).toContain("confirm your email first");
    expect(t).not.toContain("different address");
    expect(t).toContain("confirm it by signing in with a link"); // no mail server in the test, so no button, but the way forward is named
    expect(t).not.toContain("join workspace");
  });

  it("a confirmed matching address gets the Join button", async () => {
    const { token } = await invitedPerson({ email: "ivy@example.com", verified: true, signedIn: true });
    const t = await render(token);
    expect(t).toContain("join workspace");
    expect(t).not.toContain("different address");
  });

  it("someone signed in with another address is told so and can sign out to use another account", async () => {
    const { token } = await invitedPerson({ email: "other@example.com", verified: true, signedIn: true });
    const t = await render(token);
    expect(t).toContain("different address");
    expect(t).toContain("sign out and use another account");
  });

  it("an invalid link is a dead end with a next step", async () => {
    await invitedPerson({ email: "ivy@example.com", verified: true, signedIn: false });
    const t = await render("x".repeat(40));
    expect(t).toContain("this invitation is not valid");
    expect(t).toContain("/sign-in");
  });
});

describe("onboarding", () => {
  it("lists a pending invitation for the verified address, with a Join button, next to the way to create a workspace", async () => {
    await invitedPerson({ email: "ivy@example.com", verified: true, signedIn: false });
    const user = await db().user.create({ data: { login: "ivy", email: "ivy@example.com", emailVerifiedAt: new Date() } });
    const { token: session } = await createSession(db(), user.id, new Date());
    state.jar.set(SESSION_COOKIE, { value: session, options: {} });
    const t = text(await (await import("@/app/onboarding/page")).default({ searchParams: Promise.resolve({}) }));
    expect(t).toContain("you have been invited");
    expect(t).toContain("acme co");
    expect(t).toContain("join workspace");
    expect(t).toContain("create workspace");
  });

  it("keeps the typed name when it comes back with an error, and says something useful for an unknown error", async () => {
    const user = await db().user.create({ data: { login: "zed", email: "zed@example.com", emailVerifiedAt: new Date() } });
    const { token: session } = await createSession(db(), user.id, new Date());
    state.jar.set(SESSION_COOKIE, { value: session, options: {} });
    const page = (await import("@/app/onboarding/page")).default;
    const t = text(await page({ searchParams: Promise.resolve({ error: "weird", name: "My Team" }) }));
    expect(t).toContain("my team");
    expect(t).toContain("something went wrong. try again.");
  });
});
