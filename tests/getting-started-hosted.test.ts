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
  it("does not promise a GitHub sign-in or a GitHub-repository team, and points invitations at the members page", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
    const s = await steps(ids.users.admin.id);
    expect(s.repos.why).toMatch(/GitHub is not connected yet/);
    expect(s.repos.why).not.toMatch(/Only reads them with your own GitHub sign-in/i);
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
