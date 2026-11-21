import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, state } from "./auth-mocks";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { bind, hostedGithub, releaseApp, useApp } from "./github-hosted-helpers";
import { enqueue, runOne } from "@/lib/jobs";
import { loadBoundInstallation } from "@/lib/github/binding";
import { resetInstallationTokenCache } from "@/lib/github/app-auth";
import { GithubNotConnectedError, GithubWritesDisabledError } from "@/lib/github/hosted";
import { installationBudgetKey, installationCachePrefix, portForDiscovery, portForSync, portForWrite } from "@/lib/github/factory";
import { workspaceGithubStatus } from "@/lib/github/status";
import { listInstallationRepos, trackInstallationRepos } from "@/lib/services/installation-repos";
import { ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * Hosted sync through a GitHub App installation, against the in-memory GitHub. Covers: a bound workspace syncs with the installation
 * token (never a person's or the server's credential); an unbound workspace stays "not connected"; two workspaces sharing one
 * installation each see only what THEY tracked; budgets and cache keys are per installation; an uninstalled App is recorded and not
 * retried; and no token ever reaches a log, an error or a stored message.
 */
vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
const db = () => state.db!;
let gh: ReturnType<typeof hostedGithub>;
let inst: { id: number; accountLogin: string; accountId: number };

beforeEach(async () => {
  state.db = createTestPrisma(`github-hosted-sync-${n++}`);
  state.jar.clear();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("DEMO_MODE", "false");
  gh = hostedGithub();
  await gh.create("pub", false);
  await gh.create("priv", true);
  await gh.create("other-private", true);
  gh.server.addWork("acme", "pub", { number: 1, title: "Public issue", updatedAt: "2026-11-01T10:00:00Z" });
  gh.server.addWork("acme", "priv", { number: 1, kind: "pr", title: "Secret PR", author: "alice-gh", updatedAt: "2026-11-02T10:00:00Z", requested: ["bob-gh"], reviews: [{ id: 501, user: "carol-gh", state: "APPROVED" }] });
  gh.server.addWork("acme", "priv", { number: 2, title: "Secret issue", updatedAt: "2026-11-03T10:00:00Z", comments: [{ id: 601, user: "alice-gh", body: "hello" }] });
  // The installation covers pub and priv; other-private is on the same account but not selected.
  const i = gh.server.addInstallation("acme", { repos: ["acme/pub", "acme/priv"], selection: "selected" });
  inst = { id: i.id, accountLogin: "acme", accountId: i.accountId };
  useApp(gh.server, gh.app);
});
afterEach(async () => {
  releaseApp();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.db!.$disconnect();
});

async function workspace(name: string) {
  const w = await workspaceWithOwner(db(), `${name}@example.com`, name);
  await bind(db(), w.ws.id, inst);
  return w;
}
const githubIdOf = (name: string) => String(gh.server.repo("acme", name)!.id);
const drain = async () => {
  const { handlers } = await import("@/lib/local/handlers");
  const out: string[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await runOne(db(), handlers);
    if (r === "idle") break;
    out.push(r);
  }
  return out;
};

describe("a bound workspace syncs through the installation", () => {
  it("tracks the chosen repository, syncs its issues and pull requests with the installation token, and spends the installation's budget", async () => {
    const w = await workspace("alpha");
    const rows = await trackInstallationRepos(db(), w.viewer, [githubIdOf("priv")]);
    expect(rows).toHaveLength(1);
    expect((await db().repository.findUniqueOrThrow({ where: { id: rows[0].id } })).installationId).toBe(BigInt(inst.id));
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: rows[0].id, full: true }, dedupeKey: `sync:${rows[0].id}`, workspaceId: w.ws.id });
    expect(await drain()).toEqual(["done"]);

    const items = await db().workItem.findMany({ where: { repositoryId: rows[0].id }, orderBy: { number: "asc" } });
    expect(items.map((i) => [i.number, i.type, i.title])).toEqual([[1, "PULL_REQUEST", "Secret PR"], [2, "ISSUE", "Secret issue"]]);
    expect(await db().reviewRequest.count({ where: { workItem: { repositoryId: rows[0].id }, reviewerRef: "bob-gh", removedAt: null } })).toBe(1);
    expect(await db().workItemComment.count({ where: { workItem: { repositoryId: rows[0].id }, kind: "REVIEW", authorLogin: "carol-gh" } })).toBe(1);
    expect((await db().repository.findUniqueOrThrow({ where: { id: rows[0].id } })).syncError).toBeNull();

    // Every GitHub call after the token request carried an installation token: none went out as a person (`/user/...`) or the server.
    const asInstallation = gh.server.calls.filter((c) => c.startsWith(`inst:${inst.id} `));
    expect(asInstallation.some((c) => c.includes("GET /repos/acme/priv/issues"))).toBe(true);
    expect(gh.server.calls.filter((c) => /GET \/user\b/.test(c))).toEqual([]);
    // Budget and cache are the installation's own.
    expect((await db().rateLimitState.findMany({ where: { key: { not: { startsWith: "ws:" } } } })).map((r) => r.key)).toEqual([installationBudgetKey(inst.id)]); // (ws:create:* are the signup limiter rows)
    const keys = (await db().publicCacheEntry.findMany({ select: { key: true } })).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith(installationCachePrefix(inst.id)))).toBe(true);
  });

  it("an unchanged second run is answered from the installation's own cache (304) and nothing new is stored", async () => {
    const w = await workspace("beta");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("priv")]);
    for (let i = 0; i < 2; i++) {
      await enqueue(db(), { type: "sync.repository", payload: { repositoryId: r.id, full: true }, dedupeKey: `sync:${r.id}`, workspaceId: w.ws.id });
      expect(await drain()).toEqual(["done"]);
    }
    expect(await db().workItem.count({ where: { repositoryId: r.id } })).toBe(2);
  });

  it("reconcile.all queues work only for workspaces with a usable connection, and only for installation-served repositories", async () => {
    const bound = await workspace("gamma");
    const [r] = await trackInstallationRepos(db(), bound.viewer, [githubIdOf("pub")]);
    const unbound = await workspaceWithOwner(db(), "delta@example.com", "delta");
    const owner = await db().githubOwner.create({ data: { githubId: 99n, login: "x" } });
    const stray = await db().repository.create({ data: { workspaceId: unbound.ws.id, githubId: 9n, ownerId: owner.id, name: "stray", fullName: "x/stray", htmlUrl: "https://github.com/x/stray", visibility: "PUBLIC", defaultBranch: "main" } });
    const local = await db().repository.create({ data: { workspaceId: bound.ws.id, githubId: 10n, ownerId: owner.id, name: "imported", fullName: "x/imported", htmlUrl: "https://github.com/x/imported", visibility: "PUBLIC", defaultBranch: "main" } });
    await enqueue(db(), { type: "reconcile.all", payload: {}, workspaceId: null });
    const { handlers } = await import("@/lib/local/handlers");
    expect(await runOne(db(), handlers)).toBe("done");
    const queued = (await db().job.findMany({ where: { type: "sync.repository" } })).map((j) => (j.payload as { repositoryId: string }).repositoryId);
    expect(queued).toEqual([r.id]);
    expect(queued).not.toContain(stray.id);
    expect(queued).not.toContain(local.id); // tracked by URL, no installation: nothing to read it with
  });

  it("the coordination lane paces reconcile.all every 15 minutes once any workspace is connected, and not before", async () => {
    const { coordinate } = await import("@/lib/local/scheduler");
    await coordinate(Date.now());
    expect(await db().job.count({ where: { type: "reconcile.all" } })).toBe(0);
    await workspace("epsilon");
    await coordinate(Date.now());
    const j = await db().job.findFirstOrThrow({ where: { type: "reconcile.all" } });
    expect(j.intervalMs).toBe(15 * 60_000);
    expect(j.workspaceId).toBeNull();
    expect(await db().job.count({ where: { type: { in: ["digest.daily", "ai.autopilot"] } } })).toBe(2);
  });
});

describe("a workspace without a connection stays 'not connected'", () => {
  it("its jobs finish as no-ops, its ports refuse with the typed error, and the connect list says so", async () => {
    const w = await workspaceWithOwner(db(), "zeta@example.com", "zeta");
    const owner = await db().githubOwner.create({ data: { githubId: 99n, login: "acme" } });
    const repo = await db().repository.create({ data: { workspaceId: w.ws.id, githubId: 7n, ownerId: owner.id, name: "priv", fullName: "acme/priv", htmlUrl: "https://github.com/acme/priv", visibility: "PRIVATE", defaultBranch: "main" } });
    await expect(portForSync(db(), repo.id)).rejects.toBeInstanceOf(GithubNotConnectedError);
    await expect(portForDiscovery(db(), { id: "1", login: "x" }, { workspaceId: w.ws.id })).rejects.toBeInstanceOf(GithubNotConnectedError);
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: repo.id }, dedupeKey: "s", workspaceId: w.ws.id });
    expect(await drain()).toEqual(["done"]);
    expect(await db().workItem.count()).toBe(0);
    expect(gh.server.calls.filter((c) => c.startsWith("inst:"))).toEqual([]);
    expect(await workspaceGithubStatus(db(), w.ws.id)).toEqual({ configured: true, bound: false, suspended: false });
    expect((await listInstallationRepos(db(), w.ws.id)).state).toBe("not-connected");
    await expect(trackInstallationRepos(db(), w.viewer, [githubIdOf("pub")])).rejects.toBeInstanceOf(GithubNotConnectedError);
  });

  it("a repository whose installation is bound only by ANOTHER workspace gets no token", async () => {
    const a = await workspace("eta");
    const b = await workspaceWithOwner(db(), "theta@example.com", "theta");
    const [ra] = await trackInstallationRepos(db(), a.viewer, [githubIdOf("priv")]);
    // A repository row of workspace B cannot name A's binding (composite foreign key), so B's copy has none and stays unconnected.
    const o = await db().githubOwner.findFirstOrThrow();
    const rb = await db().repository.create({ data: { workspaceId: b.ws.id, githubId: ra.githubId, ownerId: o.id, name: "priv", fullName: "acme/priv", htmlUrl: "https://github.com/acme/priv", visibility: "PRIVATE", defaultBranch: "main" } });
    await expect(portForSync(db(), rb.id)).rejects.toBeInstanceOf(GithubNotConnectedError);
    expect(await loadBoundInstallation(db(), b.ws.id, BigInt(inst.id))).toBeNull();
  });
});

describe("two workspaces sharing one installation", () => {
  it("each sees only the repositories it tracked, and its own work items", async () => {
    const a = await workspace("iota");
    const b = await workspace("kappa");
    await trackInstallationRepos(db(), a.viewer, [githubIdOf("priv")]);
    await trackInstallationRepos(db(), b.viewer, [githubIdOf("pub")]);
    for (const r of await db().repository.findMany()) await enqueue(db(), { type: "sync.repository", payload: { repositoryId: r.id, full: true }, dedupeKey: `sync:${r.id}`, workspaceId: r.workspaceId });
    expect((await drain()).every((x) => x === "done")).toBe(true);
    const names = async (ws: string) => (await db().repository.findMany({ where: { workspaceId: ws } })).map((r) => r.fullName);
    expect(await names(a.ws.id)).toEqual(["acme/priv"]);
    expect(await names(b.ws.id)).toEqual(["acme/pub"]);
    const titles = async (ws: string) => (await db().workItem.findMany({ where: { repository: { workspaceId: ws } } })).map((i) => i.title).sort();
    expect(await titles(a.ws.id)).toEqual(["Secret PR", "Secret issue"]);
    expect(await titles(b.ws.id)).toEqual(["Public issue"]);
    // The one budget is shared, because GitHub's quota is the installation's.
    expect((await db().rateLimitState.findMany({ where: { key: { not: { startsWith: "ws:" } } } })).map((r) => r.key)).toEqual([installationBudgetKey(inst.id)]); // (ws:create:* are the signup limiter rows)
  });

  it("the list offers what the installation covers (not the account's other repositories) and only an administrator may track it", async () => {
    const w = await workspace("lambda");
    const list = await listInstallationRepos(db(), w.ws.id);
    expect(list.state).toBe("ok");
    expect(list.repos.map((r) => [r.meta.fullName, r.meta.visibility])).toEqual([["acme/priv", "PRIVATE"], ["acme/pub", "PUBLIC"]]);
    const m = await addMember(db(), w.ws.id, "member@example.com", "MEMBER");
    await expect(trackInstallationRepos(db(), await m.viewer(), [githubIdOf("pub")])).rejects.toBeInstanceOf(ForbiddenError);
    // An id the installation does not list is refused, whatever the form said.
    await expect(trackInstallationRepos(db(), w.viewer, [githubIdOf("other-private")])).rejects.toBeInstanceOf(ValidationError);
    expect(await db().repository.count({ where: { workspaceId: w.ws.id } })).toBe(0);
  });

  it("untracking keeps the binding and nulls nothing else", async () => {
    const w = await workspace("mu");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("pub")]);
    const { removeFromTracking } = await import("@/lib/services/repositories");
    await removeFromTracking(db(), w.viewer, r.id);
    const after = await db().repository.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.trackingStatus).toBe("REMOVED");
    expect(after.installationId).toBe(BigInt(inst.id));
    expect(await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id))).not.toBeNull();
  });
});

describe("when GitHub says the installation is gone", () => {
  it("an uninstalled App is recorded once, the job finishes without a retry, and the workspace reads as not connected", async () => {
    const w = await workspace("nu");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("pub")]);
    gh.server.installations.delete(inst.id);
    resetInstallationTokenCache(); // the process may still hold a token minted before the uninstall (one hour); a fresh request is what learns of it
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: "s", workspaceId: w.ws.id });
    expect(await drain()).toEqual(["done"]);
    const row = await db().githubInstallation.findUniqueOrThrow({ where: { installationId: BigInt(inst.id) } });
    expect(row.deletedAt).not.toBeNull();
    expect(await workspaceGithubStatus(db(), w.ws.id)).toMatchObject({ bound: false, suspended: false });
    expect(await db().job.count({ where: { status: { in: ["QUEUED", "FAILED"] } } })).toBe(0);
  });

  it("a suspended App is recorded as suspended", async () => {
    const w = await workspace("xi");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("pub")]);
    gh.server.installations.get(inst.id)!.suspended = true;
    resetInstallationTokenCache();
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: "s", workspaceId: w.ws.id });
    expect(await drain()).toEqual(["done"]);
    expect(await workspaceGithubStatus(db(), w.ws.id)).toEqual({ configured: true, bound: false, suspended: true });
  });
});

describe("read-only phase", () => {
  it("portForWrite refuses with the typed 'not enabled yet' error and the message says so", async () => {
    await expect(portForWrite(db(), { id: "1", login: "x" }, { isDemo: false })).rejects.toBeInstanceOf(GithubWritesDisabledError);
    await expect(portForWrite(db(), { id: "1", login: "x" }, { isDemo: false })).rejects.toThrow("GitHub writes are not enabled yet");
    const { run } = await import("@/lib/action-result");
    expect(await run(async () => void (await portForWrite(db(), { id: "1", login: "x" }, { isDemo: false })))).toEqual({ ok: false, error: "GitHub writes are not enabled yet" });
  });

  it("the fake refuses a write made with an installation token (the App holds read permissions only)", async () => {
    const w = await workspace("omicron");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("pub")]);
    const port = await (await import("@/lib/github/factory")).installationPort(db(), (await loadBoundInstallation(db(), w.ws.id, BigInt(inst.id)))!);
    await expect(port.createComment("acme", "pub", 1, "hi")).rejects.toBeDefined();
    expect(r.id).toBeTruthy();
  });
});

describe("the token never leaks", () => {
  it("is not in a log line, a job error, a repository error or an action message, even when GitHub fails", async () => {
    const logs: string[] = [];
    for (const k of ["log", "error", "warn", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
    const w = await workspace("pi");
    const [r] = await trackInstallationRepos(db(), w.viewer, [githubIdOf("priv")]);
    gh.server.failNext(/\/repos\/acme\/priv\/issues/, 500, "boom", 1);
    await enqueue(db(), { type: "sync.repository", payload: { repositoryId: r.id, full: true }, dedupeKey: "s", workspaceId: w.ws.id, maxAttempts: 1 });
    expect(await drain()).toEqual(["failed"]);
    const tokens = gh.server.issuedInstallationTokens();
    expect(tokens.length).toBeGreaterThan(0);
    const stored = JSON.stringify([await db().job.findMany(), await db().repository.findMany(), await db().auditLog.findMany(), logs], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const t of tokens) expect(stored.includes(t)).toBe(false);
    expect(stored).not.toMatch(/ghs_/);
  });
});
