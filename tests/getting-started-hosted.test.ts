import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { BASE } from "./helpers";
import type { Db } from "@/lib/db";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { loadViewer } from "@/lib/authz/viewer";
import { gettingStarted } from "@/lib/services/getting-started";

let db: Db;
let ids: DemoIds;
let n = 0;
beforeEach(async () => {
  db = createTestPrisma(`getting-started-hosted-${n++}`);
  ids = await seedDemo(db, BASE);
});
afterEach(() => vi.unstubAllEnvs());

const steps = async (userId: string) => Object.fromEntries((await gettingStarted(db, (await loadViewer(db, userId))!)).map((s) => [s.key, s]));

describe("the Get started card in a hosted workspace", () => {
  it("step 1 is 'Connect GitHub' for an administrator, points at Settings > GitHub, and ticks itself once a connection is active", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
    const s = await steps(ids.users.admin.id);
    expect(s.repos).toMatchObject({ title: "Connect GitHub", href: "/settings/github", cta: "Connect GitHub", locked: undefined, done: false });
    expect(s.repos.why).not.toMatch(/Only reads them with your own GitHub sign-in/i);
    const ws = (await db.workspace.findFirstOrThrow()).id;
    await db.githubInstallation.create({ data: { installationId: 9n, accountGithubId: 5n, accountLogin: "acme", accountType: "ORGANIZATION" } });
    await db.workspaceInstallation.create({ data: { workspaceId: ws, installationId: 9n, verifiedAt: new Date(), verifiedGithubUserId: 1n, proofMethod: "user-installations:self" } });
    expect((await steps(ids.users.admin.id)).repos.done).toBe(true);
    await db.githubInstallation.update({ where: { installationId: 9n }, data: { suspendedAt: new Date() } });
    const suspended = (await steps(ids.users.admin.id)).repos;
    expect(suspended).toMatchObject({ done: false, cta: "Open GitHub settings" });
    expect(suspended.why).toMatch(/suspended or removed/);
  });

  it("step 1 tells a member to ask, without a button", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
    const s = await steps(ids.users.b.id);
    expect(s.repos.locked).toMatch(/Ask the owner or an administrator to connect GitHub/);
  });

  it("does not promise a GitHub sign-in or a GitHub-repository team, and points invitations at the members page", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
    const s = await steps(ids.users.admin.id);
    expect(s.team.href).toBe("/settings/members");
    expect(s.team.cta).toBe("Invite people");
    expect(s.team.why).not.toMatch(/private GitHub repository|Nobody runs a server/);
    expect(s.team.done).toBe(true); // the demo workspace has several members
  });

  it("names the owner when a member or reader is told to ask", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
    const s = await steps(ids.users.b.id);
    expect(s.team.locked).toMatch(/owner or an administrator/);
    expect(s.rules.locked).toMatch(/owner or an administrator/);
  });

  it("the local app keeps its own wording", async () => {
    const s = await steps(ids.users.admin.id);
    expect(s.repos.why).toMatch(/own GitHub sign-in/);
    expect(s.team.href).toBe("/team");
  });
});
