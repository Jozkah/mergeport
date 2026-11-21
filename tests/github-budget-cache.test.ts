import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, state } from "./auth-mocks";
import { workspaceWithOwner } from "./roles-helpers";
import { bind, hostedGithub, releaseApp, useApp } from "./github-hosted-helpers";
import { dbCache, installationBudgetKey, installationCachePrefix, installationPort } from "@/lib/github/factory";
import { loadBoundInstallation } from "@/lib/github/binding";
import { GithubError } from "@/lib/github/port";

/**
 * GitHub's quota and ETag cache belong to a CREDENTIAL. A hosted installation's budget is its own (`installation:<id>`), never the
 * local app's single "source" key, and what is fetched with an installation token is cached under that installation's prefix only,
 * so a private body is never answered to a request made with another credential.
 */
vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
const db = () => state.db!;
beforeEach(() => {
  state.db = createTestPrisma(`github-budget-cache-${n++}`);
  state.jar.clear();
});
afterEach(async () => {
  releaseApp();
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});

describe("the cache key is partitioned by credential", () => {
  it("the same request cached under two installations (and the global cache) never answers across them", async () => {
    const global = dbCache(db());
    const one = dbCache(db(), installationCachePrefix(1));
    const two = dbCache(db(), installationCachePrefix(2));
    await one.set("GET /repos/acme/priv/issues {}", '"etag-one"', { __mp: 1, data: ["SECRET-ONE"], link: null });
    await two.set("GET /repos/acme/priv/issues {}", '"etag-two"', { __mp: 1, data: ["SECRET-TWO"], link: null });
    expect((await one.get("GET /repos/acme/priv/issues {}"))?.etag).toBe('"etag-one"');
    expect((await two.get("GET /repos/acme/priv/issues {}"))?.etag).toBe('"etag-two"');
    expect(await global.get("GET /repos/acme/priv/issues {}")).toBeNull(); // the shared cache holds nothing of either
    expect((await db().publicCacheEntry.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((r) => r.key)).toEqual([
      `inst:1:GET /repos/acme/priv/issues {}`,
      `inst:2:GET /repos/acme/priv/issues {}`,
    ]);
  });

  it("the key prefix names the installation and cannot be forged by a request key", () => {
    expect(installationCachePrefix(77n)).toBe("inst:77:");
    expect(installationBudgetKey(77n)).toBe("installation:77");
    expect(installationBudgetKey(77n)).not.toBe("source");
  });

  it("everything an installation port fetches lands under that installation's prefix, and the global cache stays empty", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    const gh = hostedGithub();
    await gh.create("priv", true);
    gh.server.addWork("acme", "priv", { number: 1, title: "Secret", updatedAt: "2026-11-02T10:00:00Z" });
    const i = gh.server.addInstallation("acme", { repos: ["acme/priv"] });
    useApp(gh.server, gh.app);
    const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
    await bind(db(), w.ws.id, { id: i.id, accountLogin: "acme", accountId: i.accountId });
    const port = await installationPort(db(), (await loadBoundInstallation(db(), w.ws.id, BigInt(i.id)))!);
    expect((await port.getRepository("acme", "priv")).visibility).toBe("PRIVATE");
    await port.listIssuesAndPulls("acme", "priv", { page: 1 });
    await port.listInstallationRepositories(1);
    const keys = (await db().publicCacheEntry.findMany({ select: { key: true } })).map((r) => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(2); // the repository and its issues list (the fake sends no ETag for the installation list)
    expect(keys.every((k) => k.startsWith(installationCachePrefix(i.id)))).toBe(true);
    // A second read with the same token sends the stored ETag and gets the stored body back (conditional request, no new rate limit spent).
    const asInst = () => gh.server.calls.filter((c) => c.startsWith("inst:")).length;
    const before = asInst();
    expect((await port.getRepository("acme", "priv")).fullName).toBe("acme/priv");
    expect(asInst()).toBe(before + 1);
  });
});

describe("the budget is per installation", () => {
  const SOON = () => new Date(Date.now() + 60 * 60_000);

  it("an exhausted installation holds back its own jobs and no other installation's, nor the local 'source' key", async () => {
    const { guardSourceBudget } = await import("@/lib/local/handlers");
    await db().rateLimitState.create({ data: { key: installationBudgetKey(1), remaining: 0, limit: 5000, resetAt: SOON() } });
    await expect(guardSourceBudget(installationBudgetKey(1))).rejects.toBeInstanceOf(GithubError);
    await expect(guardSourceBudget(installationBudgetKey(2))).resolves.toBeUndefined(); // another installation: its own, untouched budget
    await expect(guardSourceBudget()).resolves.toBeUndefined(); // the local app's key is separate too
  });

  it("a hosted repository spends from its installation's key; a repository without one, and every local repository, from 'source'", async () => {
    const { sourceBudgetKeyFor } = await import("@/lib/local/handlers");
    const w = await workspaceWithOwner(db(), "owner@acme.test", "Acme");
    const o = await db().githubOwner.create({ data: { githubId: 5n, login: "acme" } });
    await db().githubInstallation.create({ data: { installationId: 31n, accountGithubId: 5n, accountLogin: "acme", accountType: "ORGANIZATION" } });
    await db().workspaceInstallation.create({ data: { workspaceId: w.ws.id, installationId: 31n, verifiedAt: new Date(), verifiedGithubUserId: 1n, proofMethod: "user-installations" } });
    const mk = (githubId: bigint, name: string) => db().repository.create({ data: { workspaceId: w.ws.id, githubId, ownerId: o.id, name, fullName: `acme/${name}`, htmlUrl: "https://github.com/acme/x", visibility: "PRIVATE", defaultBranch: "main" } });
    const served = await mk(1n, "served");
    const bare = await mk(2n, "bare");
    const { setRepositoryInstallation } = await import("@/lib/github/binding");
    await setRepositoryInstallation(db(), w.ws.id, served.id, 31n);
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    expect(await sourceBudgetKeyFor(served.id)).toBe("installation:31");
    expect(await sourceBudgetKeyFor(bare.id)).toBe("source");
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect(await sourceBudgetKeyFor(served.id)).toBe("source"); // the local app has one credential and one budget
  });
});
