import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { ghFetch } from "@/lib/github/gh";
import { GitHubRest } from "@/lib/github/rest";
import { ensureLocalProfile } from "@/lib/local/profile";
import { profileRunner } from "@/lib/local/profile-runner";
import { SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { clock, makeClient } from "./harness";
import { useFakeGh } from "./fake-gh";

/**
 * "gh auth switch" is simulated by rewriting the state file a REAL child process reads. The fake gh serves a call with
 * the explicit token it was given, or, if it was given none, with whichever account is currently selected: exactly the
 * hazard being guarded against. The log records what each process actually saw.
 */
let gh: ReturnType<typeof useFakeGh>;
const dbs: { close: () => Promise<void>; file: string }[] = [];

async function profile(login: string, id: number) {
  const file = path.resolve(".data", `client-binding-${login}-${process.pid}-${dbs.length}.db`);
  const db = createPrisma(file);
  await ensureLocalProfile(db, { id: BigInt(id), login, name: login, avatarUrl: null, host: "github.com" });
  dbs.push({ close: () => db.$disconnect(), file });
  return db;
}
const post = (f: typeof fetch, repo: string) => f(`https://api.github.com/repos/acme/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "t" }) });

beforeEach(() => {
  gh = useFakeGh({ active: "alice", accounts: { alice: { id: 1, token: "tok-alice" }, bram: { id: 2, token: "tok-bram" } } });
});
afterEach(async () => {
  gh.cleanup();
  await Promise.all(dbs.map((d) => d.close()));
  for (const d of dbs.splice(0)) for (const s of ["", "-wal", "-shm"]) fs.rmSync(d.file + s, { force: true });
});

describe("a write is bound to the profile's own account, not to whoever gh has selected", () => {
  it("switch BEFORE dispatch: profile A still writes as A", async () => {
    const a = await profile("alice", 1);
    gh.switchTo("bram"); // before anything is sent
    const res = await post(ghFetch(profileRunner(a)), "x");
    expect(res.status).toBe(201);
    expect((await res.json()).by).toBe("alice");
    const w = gh.apiCalls();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ served: "alice", explicit: true });
  });

  it("switch DURING dispatch: the call in flight and the next one both stay A", async () => {
    const a = await profile("alice", 1);
    const f = ghFetch(profileRunner(a));
    await post(f, "warm"); // credential acquired and verified
    gh.set({ delayMs: 500 });
    const inFlight = post(f, "slow");
    await new Promise((r) => setTimeout(r, 200));
    gh.set({ active: "bram", delayMs: 0 }); // switched while the process is running
    const second = await post(f, "after");
    expect((await (await inFlight).json()).by).toBe("alice");
    expect((await second.json()).by).toBe("alice");
    expect(gh.apiCalls().every((c) => c.served === "alice")).toBe(true);
  });

  it("switch between QUEUEING and RETRY: the retry is still A, or it is blocked; it is never sent as B", async () => {
    const a = await profile("alice", 1);
    const f = ghFetch(profileRunner(a));
    gh.switchTo("bram");
    // A is still signed in: the retry goes out as A.
    expect((await (await post(f, "retry-1")).json()).by).toBe("alice");
    // A signs out and only B remains. The call already in progress carries A's (now revoked) token and is rejected by GitHub...
    gh.set({ accounts: { bram: { id: 2, token: "tok-bram" } }, active: "bram" });
    expect((await post(f, "retry-2")).status).toBe(401);
    // ...and from then on the retry is BLOCKED before anything is sent, with a reason a person can act on.
    const before = gh.apiCalls().length;
    const blocked = await post(f, "retry-3");
    expect(blocked.status).toBe(401);
    expect(blocked.headers.get("x-mergeport-identity")).toBe("not-signed-in");
    expect((await blocked.json()).message).toMatch(/not signed in.*Run: gh auth login/i);
    expect(gh.apiCalls().length).toBe(before);
    expect(gh.apiCalls().some((c) => c.served === "bram")).toBe(false); // nothing ever went out as B
  });

  it("a login that now belongs to a different account (id changed) is refused", async () => {
    const a = await profile("alice", 1);
    gh.set({ accounts: { alice: { id: 99, token: "tok-someone-else" }, bram: { id: 2, token: "tok-bram" } } });
    const res = await post(ghFetch(profileRunner(a)), "x");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-mergeport-identity")).toBe("mismatch");
    expect(gh.apiCalls()).toHaveLength(0);
  });

  it("two profiles in one process never cross: A is A and B is B while the CLI has a third selected", async () => {
    const a = await profile("alice", 1);
    const b = await profile("bram", 2);
    gh.switchTo("bram");
    const [ra, rb] = await Promise.all([post(ghFetch(profileRunner(a)), "one"), post(ghFetch(profileRunner(b)), "two")]);
    expect((await ra.json()).by).toBe("alice");
    expect((await rb.json()).by).toBe("bram");
    gh.switchTo("alice");
    const again = await post(ghFetch(profileRunner(b)), "three");
    expect((await again.json()).by).toBe("bram");
  });
});

describe("credentials stay out of arguments, logs and responses", () => {
  it("the token travels only in the child's environment", async () => {
    const a = await profile("alice", 1);
    await post(ghFetch(profileRunner(a)), "x");
    const calls = gh.calls();
    for (const c of calls) expect(c.argv.join(" ")).not.toMatch(/tok-alice|tok-bram/);
    expect(calls.filter((c) => c.kind === "api").every((c) => c.ghTokenEnv === "tok-alice")).toBe(true);
  });

  it("a token echoed by gh is redacted from what the caller sees", async () => {
    const a = await profile("alice", 1);
    const f = ghFetch(profileRunner(a));
    await post(f, "warm");
    gh.set({ leakTokenToStderr: true });
    const runner = profileRunner(a);
    const r = await runner(["api", "--hostname", "github.com", "repos/acme/x"]);
    expect(r.stderr).not.toContain("tok-alice");
    expect(r.stderr).toContain("***");
  });

  it("an inherited GH_TOKEN or GITHUB_TOKEN is never used", async () => {
    process.env.GH_TOKEN = "inherited-evil";
    process.env.GITHUB_TOKEN = "inherited-evil-2";
    try {
      const a = await profile("alice", 1);
      await post(ghFetch(profileRunner(a)), "x");
      const calls = gh.calls();
      expect(calls.some((c) => c.ghTokenEnv === "inherited-evil" || c.inheritedToken === "inherited-evil-2")).toBe(false);
      expect(calls.filter((c) => c.kind === "api").every((c) => c.ghTokenEnv === "tok-alice")).toBe(true);
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe("failures block or look offline; they never fall back", () => {
  it("a CLI too old to name an account blocks instead of using the selected one", async () => {
    gh.set({ noUserFlag: true });
    const a = await profile("alice", 1);
    const res = await post(ghFetch(profileRunner(a)), "x");
    expect(res.headers.get("x-mergeport-identity")).toBe("unsupported-gh");
    expect(gh.apiCalls()).toHaveLength(0);
  });

  it("offline while verifying is an unreachable GitHub, not an identity problem, and nothing is sent", async () => {
    const a = await profile("alice", 1);
    gh.set({ offline: true });
    await expect(post(ghFetch(profileRunner(a)), "x")).rejects.toBeInstanceOf(TypeError);
    gh.set({ offline: false });
    expect((await post(ghFetch(profileRunner(a)), "x")).status).toBe(201); // recovers without a restart
  });

  it("a rejected token (401) is forgotten, and the next call re-verifies from scratch", async () => {
    const a = await profile("alice", 1);
    const f = ghFetch(profileRunner(a));
    expect((await post(f, "ok")).status).toBe(201);
    gh.set({ accounts: { alice: { id: 1, token: "tok-alice-rotated" }, bram: { id: 2, token: "tok-bram" } } }); // old token no longer exists
    expect((await post(f, "stale")).status).toBe(401);
    const fresh = await post(f, "fresh"); // re-acquired the rotated token for alice and verified its id
    expect(fresh.status).toBe(201);
    expect(gh.apiCalls().at(-1)?.ghTokenEnv).toBe("tok-alice-rotated");
  });
});

describe("queued retries in the sync engine", () => {
  it("an edit queued as A is kept, not sent as B, when A can no longer be used; it goes out as A after reconnecting", async () => {
    const server = new FakeGitHubServer(() => clock.t);
    for (const u of ["alice", "bram"]) server.addUser(u);
    const alice = await makeClient(server, "alice");
    try {
      const plan = await alice.team.planTeam({ name: "Atlas" });
      const common = await alice.team.createTeam(plan, { confirmed: true });
      // a queued edit
      await alice.db.outboxOp.create({ data: { id: "op-1", spaceId: common.id, entityType: "project", entityId: "p1", kind: "UPSERT", data: { name: "N", slug: "n", description: null, repoIds: [] }, baseVersion: 0 } });
      // this engine talks through the bound gh runner (the fake CLI), and the local profile is user id of "alice" in the harness
      const ghUser = await alice.db.user.findFirstOrThrow({ where: { isDemo: false } });
      gh.set({ active: "bram", accounts: { bram: { id: 2, token: "tok-bram" } } }); // alice is signed out; bram is selected
      const engine = new SyncEngine({ db: alice.db, actor: alice.actor, now: clock.now, store: (s) => new CoordinationStore(new GitHubRest(ghFetch(profileRunner(alice.db))), s.repoOwner, s.repoName) });
      await engine.pushSpace(await alice.db.space.findUniqueOrThrow({ where: { id: common.id } }));
      expect(await alice.db.outboxOp.count({ where: { id: "op-1", status: "PENDING" } })).toBe(1);
      expect(gh.apiCalls().some((c) => c.served === "bram")).toBe(false);
      expect((await alice.db.space.findUniqueOrThrow({ where: { id: common.id } })).lastError).toMatch(/gh auth login|reconnect|signed in/i);
      expect(ghUser.login).toBe("alice");
    } finally {
      await alice.close();
    }
  });
});
