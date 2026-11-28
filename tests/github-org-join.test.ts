import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { bind } from "./github-hosted-helpers";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { githubAppConfig, resetGithubAppConfigCache } from "@/lib/github/app-config";
import { exchangeCodeForTokens } from "@/lib/github/connect-api";
import { setConnectOverridesForTests } from "@/lib/github/connect";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { joinThroughGithubNow, refreshUserAccess } from "@/lib/github/user-access";
import { linkGithubAccount } from "@/lib/github/user-link";
import { setWorkspaceGithubOrgJoin } from "@/lib/services/github-writes-setting";
import { ForbiddenError } from "@/lib/errors";

/**
 * Joining a workspace through a GitHub organization (docs/roles.md, "Joining through GitHub"): an ACTIVE member of the organization behind
 * a connected installation becomes a MEMBER, never more, only while the workspace allows it, and never after a removal. The real link,
 * refresh and join code run against the fake GitHub.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const CLIENT_ID = "Iv1.testclient01";
const CLIENT_SECRET = "client-secret-0123456789-abcdef";
const ENC_KEY = "k".repeat(40);
const REDIRECT = `${ORIGIN}/api/github/link/callback`;

let fake: FakeGitHubServer;
let n = 0;
const db = () => state.db!;
const cfg = () => githubAppConfig()!;
const key = () => Buffer.from(createHash("sha256").update(Buffer.from(ENC_KEY, "utf8")).digest());

beforeEach(() => {
  state.db = createTestPrisma(`github-org-join-${n++}`);
  state.jar.clear();
  fake = new FakeGitHubServer();
  const app = fake.registerApp("12345");
  fake.setOAuthClient(CLIENT_ID, CLIENT_SECRET);
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
  setConnectOverridesForTests({ deps: { fetch: fake.appFetch() } });
});
afterEach(async () => {
  setConnectOverridesForTests(null);
  vi.unstubAllEnvs();
  resetGithubAppConfigCache();
  await state.db!.$disconnect();
});

/**
 * Links `login` to a fresh person through the real link code. Linking happens from a workspace, so a scratch workspace is used and the
 * membership row is then deleted outright: the person ends with a working link and NO Member row anywhere (a first-time arrival).
 */
async function newcomer(email: string, login: string) {
  const scratch = await workspaceWithOwner(db(), `scratch-${email}`, "Scratch");
  const m = await addMember(db(), scratch.ws.id, email, "MEMBER");
  const code = fake.issueOAuthCode(login, { redirectUri: REDIRECT });
  const tokens = (await exchangeCodeForTokens(cfg(), { fetch: fake.appFetch() }, { code, redirectUri: REDIRECT }))!;
  expect(await linkGithubAccount(db(), { userId: m.user.id, workspaceId: scratch.ws.id, github: { id: BigInt(fake.users.get(login)!.id), login }, tokens, key: key(), now: new Date() })).toBe("linked");
  await db().member.delete({ where: { id: m.member.id } });
  return m.user;
}

/** Workspace "Acme" bound to an installation on the GitHub organization `acme`; alice-gh is a member there, mallory-gh is not. */
async function world() {
  const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
  for (const l of ["acme-owner", "alice-gh", "mallory-gh"]) fake.addUser(l);
  fake.addOrg("acme", ["acme-owner"], ["alice-gh"]);
  const inst = fake.addInstallation("acme", { selection: "all" });
  await bind(db(), w.ws.id, inst);
  return { w, inst };
}
const memberRow = (workspaceId: string, userId: string) => db().member.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });

describe("joining a workspace through a GitHub organization", () => {
  it("an active organization member with no workspace joins as MEMBER on arrival, with an audit row", async () => {
    const { w } = await world();
    const alice = await newcomer("alice@acme.test", "alice-gh");
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(true);
    const row = await memberRow(w.ws.id, alice.id);
    expect(row).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    expect(await db().auditLog.count({ where: { workspaceId: w.ws.id, action: "member.joined_via_github_org" } })).toBe(1);
  });

  it("someone who is not in the organization joins nothing", async () => {
    const { w } = await world();
    const mallory = await newcomer("mallory@x.test", "mallory-gh");
    expect(await joinThroughGithubNow(db(), mallory.id)).toBe(false);
    expect(await memberRow(w.ws.id, mallory.id)).toBeNull();
  });

  it("a removed (REVOKED) person is never brought back, and an existing role is never changed", async () => {
    const { w } = await world();
    const alice = await newcomer("alice@acme.test", "alice-gh");
    await db().member.create({ data: { workspaceId: w.ws.id, userId: alice.id, role: "READER", status: "REVOKED", revokedAt: new Date() } });
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(false);
    expect(await memberRow(w.ws.id, alice.id)).toMatchObject({ role: "READER", status: "REVOKED" });
  });

  it("the workspace switch off admits nobody; only owners and administrators can change it", async () => {
    const { w } = await world();
    const reader = await addMember(db(), w.ws.id, "reader@acme.test", "MEMBER");
    await expect(setWorkspaceGithubOrgJoin(db(), await reader.viewer(), false)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setWorkspaceGithubOrgJoin(db(), w.viewer, false)).toBe(true);
    const alice = await newcomer("alice@acme.test", "alice-gh");
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(false);
    expect(await memberRow(w.ws.id, alice.id)).toBeNull();
  });

  it("an installation on a personal account admits nobody", async () => {
    const { w, inst } = await world();
    await db().githubInstallation.update({ where: { installationId: BigInt(inst.id) }, data: { accountType: "USER" } });
    const alice = await newcomer("alice@acme.test", "alice-gh");
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(false);
    expect(await memberRow(w.ws.id, alice.id)).toBeNull();
  });

  it("the stored installation must be the organization GitHub reports for it (account id), not just the same installation id", async () => {
    const { w, inst } = await world();
    await db().githubInstallation.update({ where: { installationId: BigInt(inst.id) }, data: { accountGithubId: 999_999n } });
    const alice = await newcomer("alice@acme.test", "alice-gh");
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(false);
    expect(await memberRow(w.ws.id, alice.id)).toBeNull();
  });

  it("a person who already belongs to a workspace joins the organization's workspace on the next refresh", async () => {
    const { w } = await world();
    const alice = await newcomer("alice@acme.test", "alice-gh");
    const own = await workspaceWithOwner(db(), "alice-own@x.test", "Own");
    await db().member.create({ data: { workspaceId: own.ws.id, userId: alice.id, role: "MEMBER", status: "ACTIVE" } });
    expect(await joinThroughGithubNow(db(), alice.id)).toBe(true); // already somewhere: nothing to do now
    expect(await memberRow(w.ws.id, alice.id)).toBeNull();
    expect(await refreshUserAccess(db(), cfg(), alice.id)).toBe("ok");
    expect(await memberRow(w.ws.id, alice.id)).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
  });

  it("asks GitHub at most once a minute per person from page loads", async () => {
    await world();
    const mallory = await newcomer("mallory@x.test", "mallory-gh");
    let calls = 0;
    const base = fake.appFetch();
    setConnectOverridesForTests({ deps: { fetch: ((i: RequestInfo | URL, init?: RequestInit) => (calls++, base(i, init))) as typeof fetch } });
    const now = new Date();
    expect(await joinThroughGithubNow(db(), mallory.id, { now })).toBe(false);
    const after = calls;
    expect(after).toBeGreaterThan(0);
    expect(await joinThroughGithubNow(db(), mallory.id, { now: new Date(now.getTime() + 10_000) })).toBe(false);
    expect(calls).toBe(after);
  });
});
