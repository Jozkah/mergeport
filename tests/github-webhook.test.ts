import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, state } from "./auth-mocks";
import { workspaceWithOwner } from "./roles-helpers";
import { hostedGithub, releaseApp, useApp } from "./github-hosted-helpers";
import { setRepositoryInstallation } from "@/lib/github/binding";
import { connectionState } from "@/lib/github/connection-state";
import { pruneGithubAppData } from "@/lib/github/webhook-maintenance";
import { enqueueHostedReconcile } from "@/lib/github/webhook-pacing";
import { WEBHOOK_MAX_BYTES, verifyWebhookSignature } from "@/lib/github/webhook-signature";

/**
 * The GitHub App webhook route and what a delivery does. No test talks to GitHub: payloads are hand-written in the shape documented for
 * each event, signed with the test secret, and sent to the real route handler against a real (embedded) Postgres.
 */
const spy = vi.hoisted(() => ({ process: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/github/webhook-events", async (orig) => {
  const real = await orig<typeof import("@/lib/github/webhook-events")>();
  spy.process.mockImplementation(real.processDelivery);
  return { ...real, processDelivery: spy.process };
});
vi.mock("@/lib/jobs", async (orig) => {
  const real = await orig<typeof import("@/lib/jobs")>();
  spy.enqueue.mockImplementation(real.enqueue);
  return { ...real, enqueue: spy.enqueue };
});
vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

import { POST } from "@/app/api/github/webhook/route";

const SECRET = "w".repeat(32);
const db = () => state.db!;
let n = 0;
let seq = 0;
let errorSpy: ReturnType<typeof vi.spyOn>;

const sign = (body: string | Buffer, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const newId = () => `0f9c1a2e-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

type Opts = { event?: string | null; delivery?: string | null; sig?: string | null; headers?: Record<string, string>; ip?: string };
function post(payload: unknown, o: Opts = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { host: "app.test", "content-type": "application/json", "x-forwarded-for": o.ip ?? "203.0.113.5", ...o.headers };
  if (o.event !== null) headers["x-github-event"] = o.event ?? "issues";
  if (o.delivery !== null) headers["x-github-delivery"] = o.delivery ?? newId();
  if (o.sig !== null) headers["x-hub-signature-256"] = o.sig ?? sign(body);
  return POST(new Request(`${ORIGIN}/api/github/webhook`, { method: "POST", headers, body }));
}
const result = async (r: Response) => ((await r.json()) as { result: string }).result;

// ---- world: workspaces A and B share installation 1001; B also has installation 2002 -----------------------------------------------
const REPO = 100n; // GitHub id of a repository both workspaces track through installation 1001
const OTHER = 200n; // GitHub id of a repository B tracks through installation 2002
let A: string;
let B: string;
let rA: string;
let rB: string;
let rC: string;

async function installation(id: bigint, login: string) {
  await db().githubInstallation.create({ data: { installationId: id, accountGithubId: id + 1n, accountLogin: login, accountType: "ORGANIZATION" } });
}
const bindTo = (workspaceId: string, installationId: bigint) => db().workspaceInstallation.create({ data: { workspaceId, installationId, verifiedAt: new Date("2026-11-01T00:00:00Z"), verifiedGithubUserId: 77n, proofMethod: "user-installations:org-admin" } });
async function track(workspaceId: string, githubId: bigint, installationId: bigint) {
  const owner = await db().githubOwner.upsert({ where: { githubId: 9001n }, create: { githubId: 9001n, login: "acme", type: "ORGANIZATION" }, update: {} });
  const r = await db().repository.create({ data: { workspaceId, githubId, ownerId: owner.id, name: `r${githubId}`, fullName: `acme/r${githubId}`, htmlUrl: "https://github.com/acme/r", lastSyncedAt: new Date("2026-11-20T10:00:00Z") } });
  await setRepositoryInstallation(db(), workspaceId, r.id, installationId);
  return r.id;
}
const jobs = () => db().job.findMany({ orderBy: [{ workspaceId: "asc" }, { dedupeKey: "asc" }] });
const jobKeys = async () => (await jobs()).map((j) => `${j.workspaceId === A ? "A" : "B"}:${j.type}:${j.dedupeKey}`);
const deliveries = () => db().githubDelivery.count();
const lastWebhook = async (id: bigint) => (await db().githubInstallation.findUniqueOrThrow({ where: { installationId: id } })).lastWebhookAt;
const evt = (installation: number, extra: Record<string, unknown> = {}, repo: bigint | null = REPO) => ({ installation: { id: installation }, ...(repo ? { repository: { id: Number(repo) } } : {}), ...extra });

beforeEach(async () => {
  state.db = createTestPrisma(`github-webhook-${n++}`);
  state.jar.clear();
  spy.process.mockClear();
  spy.enqueue.mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const gh = hostedGithub();
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("DEMO_MODE", "false");
  useApp(gh.server, gh.app);
  A = (await workspaceWithOwner(db(), undefined, "A")).ws.id;
  B = (await workspaceWithOwner(db(), undefined, "B")).ws.id;
  await installation(1001n, "acme");
  await installation(2002n, "other");
  await bindTo(A, 1001n);
  await bindTo(B, 1001n);
  await bindTo(B, 2002n);
  rA = await track(A, REPO, 1001n);
  rB = await track(B, REPO, 1001n);
  rC = await track(B, OTHER, 2002n);
});
afterEach(() => {
  releaseApp();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signature check", () => {
  const ping = { zen: "Keep it logically awesome." };

  it("accepts a valid signature (ping answers 200) and calls no handler", async () => {
    const r = await post(ping, { event: "ping" });
    expect(r.status).toBe(200);
    expect(await result(r)).toBe("pong");
    expect(spy.process).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
  });

  it("accepts the digest in upper-case hex (same bytes), but not a different prefix", async () => {
    const body = JSON.stringify(ping);
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect((await post(body, { event: "ping", sig: `sha256=${hex.toUpperCase()}` })).status).toBe(200);
    expect((await post(body, { event: "ping", sig: `SHA256=${hex}` })).status).toBe(401);
    expect((await post(body, { event: "ping", sig: `sha1=${hex.slice(0, 40)}` })).status).toBe(401);
  });

  it("refuses missing, malformed, wrong-length, wrong-secret and truncated-body signatures with 401 and touches no data", async () => {
    const body = JSON.stringify(evt(1001, { action: "opened", issue: { number: 1 } }));
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    const bad: (string | null)[] = [null, "", "sha256=", "sha256=zz" + hex.slice(2), `sha256=${hex.slice(0, 62)}`, `sha256=${hex}00`, `sha256= ${hex}`, hex, sign(body, "x".repeat(32))];
    for (const sig of bad) {
      const r = await post(body, { sig });
      expect(r.status, String(sig)).toBe(401);
    }
    // a valid signature of the FULL body does not cover a truncated one
    const cut = body.slice(0, body.length - 3);
    expect((await post(cut, { sig: sign(body) })).status).toBe(401);
    expect(spy.process).not.toHaveBeenCalled();
    expect(await deliveries()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await lastWebhook(1001n)).toBeNull();
  });

  it("is checked on the RAW bytes: re-serialised but equal JSON does not verify", async () => {
    const raw = '{"installation": {"id": 1001},  "zen": "x"}';
    const signed = sign(raw);
    expect((await post(JSON.stringify(JSON.parse(raw)), { event: "ping", sig: signed })).status).toBe(401);
    expect((await post(raw, { event: "ping", sig: signed })).status).toBe(200);
  });

  it("verifyWebhookSignature compares equal-length digests only", () => {
    const body = Buffer.from("hello");
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=00")).toBe(false);
  });
});

describe("body cap", () => {
  it("refuses a declared length over 1 MiB with 413 before reading", async () => {
    const r = await post("{}", { event: "ping", headers: { "content-length": String(WEBHOOK_MAX_BYTES + 1) } }).catch((e) => e);
    // undici may refuse to build a request whose declared length disagrees with its body; either way nothing is processed
    if (r instanceof Response) expect(r.status).toBe(413);
    expect(spy.process).not.toHaveBeenCalled();
  });

  it("cuts a streamed body off at 1 MiB (no Content-Length) and answers 413", async () => {
    let sent = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > WEBHOOK_MAX_BYTES * 3) return c.close();
        sent += chunk.length;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${ORIGIN}/api/github/webhook`, { method: "POST", headers: { host: "app.test", "x-github-event": "ping", "x-github-delivery": newId(), "x-hub-signature-256": sign("x") }, body: stream, duplex: "half" } as RequestInit);
    const r = await POST(req);
    expect(r.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(WEBHOOK_MAX_BYTES * 2);
    expect(spy.process).not.toHaveBeenCalled();
  });

  it("accepts a body just under the cap", async () => {
    const body = JSON.stringify({ zen: "x".repeat(WEBHOOK_MAX_BYTES - 200) });
    expect((await post(body, { event: "ping" })).status).toBe(200);
  });
});

describe("hosted and configured only", () => {
  it("is 404 on a deployment that is not hosted", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const r = await post({ zen: "x" }, { event: "ping" });
    expect(r.status).toBe(404);
  });

  it("is 404 when the GitHub App is not configured", async () => {
    for (const k of ["ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "CLIENT_ID", "CLIENT_SECRET", "SLUG"]) vi.stubEnv(`MERGEPORT_GITHUB_APP_${k}`, "");
    const { resetGithubAppConfigCache } = await import("@/lib/github/app-config");
    resetGithubAppConfigCache();
    expect((await post({ zen: "x" }, { event: "ping" })).status).toBe(404);
  });
});

describe("headers, payload and unknown events", () => {
  it("needs x-github-event and a sane x-github-delivery (after the signature), else 400", async () => {
    const body = { installation: { id: 1001 } };
    expect((await post(body, { event: null })).status).toBe(400);
    expect((await post(body, { delivery: null })).status).toBe(400);
    for (const d of ["short", "has space in it", "x".repeat(65), "../../etc/passwd", "a;b;c;d;e;f;g"]) expect((await post(body, { delivery: d })).status, d).toBe(400);
    expect((await post(body, { event: "Issues" })).status).toBe(400);
    expect(await deliveries()).toBe(0);
  });

  it("a signed body that is not a JSON object is 400", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post("[1,2]")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
  });

  it("an event this deployment does not act on is 202 with zero writes", async () => {
    for (const [event, payload] of [
      ["star", evt(1001, { action: "created" })],
      ["workflow_run", evt(1001, { action: "completed" })],
      ["repository", evt(1001, { action: "created" })], // an irrelevant action of a relevant event
      ["installation", evt(1001, { action: "something_new" }, null)],
      ["installation_repositories", evt(1001, { action: "bogus" }, null)],
    ] as const) {
      const r = await post(payload, { event });
      expect(r.status, event).toBe(202);
    }
    expect(await deliveries()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await lastWebhook(1001n)).toBeNull();
  });

  it("a handled event without a usable installation id is 400 and writes nothing", async () => {
    for (const payload of [{ action: "opened" }, { installation: {} }, { installation: { id: "1001" } }, { installation: { id: -1 } }, { installation: { id: 1.5 } }, { installation: { id: 2 ** 60 } }]) {
      expect((await post({ ...payload, repository: { id: 100 } }, { event: "push" })).status, JSON.stringify(payload)).toBe(400);
    }
    expect(await deliveries()).toBe(0);
  });

  it("an installation we do not hold is 200 with zero writes (a webhook never creates a binding)", async () => {
    const r = await post(evt(9999, { action: "opened", issue: { number: 1 } }), { event: "issues" });
    expect(r.status).toBe(200);
    expect(await result(r)).toBe("unknown installation");
    expect(await deliveries()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await db().githubInstallation.count()).toBe(2);
    expect(await db().workspaceInstallation.count()).toBe(3);
    const created = await post(evt(9999, { action: "created" }, null), { event: "installation" });
    expect(created.status).toBe(200);
    expect(await db().githubInstallation.count()).toBe(2);
  });
});

describe("event to job mapping", () => {
  const pr = (number: number) => ({ number });
  const table: { event: string; payload: Record<string, unknown>; expect: string[] }[] = [
    { event: "issues", payload: { action: "opened", issue: pr(7) }, expect: ["sync.item:item:#:7"] },
    { event: "issue_comment", payload: { action: "created", issue: pr(7), comment: { id: 1 } }, expect: ["sync.item:item:#:7"] },
    { event: "pull_request", payload: { action: "synchronize", pull_request: pr(9) }, expect: ["sync.item:item:#:9"] },
    { event: "pull_request_review", payload: { action: "submitted", pull_request: pr(9) }, expect: ["sync.item:item:#:9"] },
    { event: "pull_request_review_comment", payload: { action: "created", pull_request: pr(9) }, expect: ["sync.item:item:#:9"] },
    { event: "pull_request_review_thread", payload: { action: "resolved", pull_request: pr(9) }, expect: ["sync.item:item:#:9"] },
    { event: "check_run", payload: { action: "completed", check_run: { pull_requests: [pr(3), pr(4), pr(3)] } }, expect: ["sync.item:item:#:3", "sync.item:item:#:4"] },
    { event: "check_run", payload: { action: "completed", check_run: { pull_requests: [] } }, expect: ["sync.repository:sync:#"] },
    { event: "check_suite", payload: { action: "completed", check_suite: { pull_requests: [pr(5)] } }, expect: ["sync.item:item:#:5"] },
    { event: "check_suite", payload: { action: "completed", check_suite: {} }, expect: ["sync.repository:sync:#"] },
    { event: "status", payload: { state: "success" }, expect: ["sync.repository:sync:#"] },
    { event: "push", payload: { ref: "refs/heads/main" }, expect: ["sync.repository:sync:#"] },
    { event: "create", payload: { ref_type: "branch" }, expect: ["sync.repository:sync:#"] },
    { event: "delete", payload: { ref_type: "branch" }, expect: ["sync.repository:sync:#"] },
    { event: "label", payload: { action: "edited" }, expect: ["sync.repository:sync:#"] },
    { event: "milestone", payload: { action: "closed" }, expect: ["sync.repository:sync:#"] },
    ...["publicized", "privatized", "renamed", "transferred", "edited", "deleted", "archived", "unarchived"].map((action) => ({ event: "repository", payload: { action }, expect: ["sync.repository:sync:#"] })),
  ];

  it.each(table.map((t, i) => [`${t.event} ${JSON.stringify(t.payload).slice(0, 50)}`, i] as const))("%s", async (_name, i) => {
    const t = table[i];
    const r = await post(evt(1001, t.payload), { event: t.event });
    expect(r.status).toBe(200);
    expect(await result(r)).toBe("ok");
    // each workspace tracking the repository through installation 1001 gets its OWN jobs; nothing for the other installation's repository
    const want = ([[A, rA], [B, rB]] as const).flatMap(([ws, repo]) => t.expect.map((e) => ({ ws, repo, e })));
    const got = await jobs();
    expect(got).toHaveLength(want.length);
    for (const w of want) {
      const [type, ...key] = w.e.split(":");
      const dedupe = key.join(":").replace("#", w.repo);
      const j = got.find((x) => x.workspaceId === w.ws && x.dedupeKey === dedupe);
      expect(j, `${w.ws} ${dedupe}`).toBeTruthy();
      expect(j!.type).toBe(type);
      expect(j!.payload).toMatchObject({ repositoryId: w.repo });
      if (type === "sync.item") expect(j!.payload).toMatchObject({ number: Number(dedupe.split(":").pop()) });
      expect(j!.status).toBe("QUEUED");
    }
  });

  it("two workspaces tracking one repository each get their own job (separate rows, separate ids)", async () => {
    await post(evt(1001, { action: "opened", issue: pr(1) }), { event: "issues" });
    const got = await jobs();
    expect(got.map((j) => j.workspaceId).sort()).toEqual([A, B].sort());
    expect(new Set(got.map((j) => j.dedupeKey)).size).toBe(2);
  });

  it("bursts coalesce: the same item twice is one job per workspace", async () => {
    await post(evt(1001, { action: "opened", issue: pr(1) }), { event: "issues" });
    await post(evt(1001, { action: "edited", issue: pr(1) }), { event: "issues" });
    expect(await jobs()).toHaveLength(2);
    expect(await deliveries()).toBe(2);
  });

  it("a repository that is not tracked, REMOVED, or demo gets no job, but the delivery is still accepted", async () => {
    await db().repository.updateMany({ where: { id: rA, workspaceId: A }, data: { trackingStatus: "REMOVED" } });
    await post(evt(1001, { action: "opened", issue: pr(1) }, 12345n), { event: "issues" });
    await post(evt(1001, { action: "opened", issue: pr(2) }), { event: "issues" });
    expect(await jobKeys()).toEqual([`B:sync.item:item:${rB}:2`]);
  });

  it("a signed payload naming ANOTHER installation's repository matches nothing", async () => {
    // Installation 2002 is genuine and signed, but repository 100 is served by 1001 in both workspaces: no job.
    expect((await post(evt(2002, { action: "opened", issue: pr(1) }, REPO), { event: "issues" })).status).toBe(200);
    expect(await jobs()).toHaveLength(0);
    // and the reverse: installation 1001 naming the repository that 2002 serves
    expect((await post(evt(1001, { action: "opened", issue: pr(1) }, OTHER), { event: "issues" })).status).toBe(200);
    expect(await jobs()).toHaveLength(0);
    // the right pair does queue
    await post(evt(2002, { action: "opened", issue: pr(1) }, OTHER), { event: "issues" });
    expect(await jobKeys()).toEqual([`B:sync.item:item:${rC}:1`]);
  });

  it("an installation the workspace never bound cannot reach its repositories, even if a repository row says so in another workspace", async () => {
    await installation(3003n, "third"); // bound to nobody
    expect((await post(evt(3003, { action: "opened", issue: pr(1) }), { event: "issues" })).status).toBe(200);
    expect(await jobs()).toHaveLength(0);
    expect(await lastWebhook(3003n)).not.toBeNull(); // known installation: accepted
  });
});

describe("dedupe and failure", () => {
  it("a repeated delivery id is a no-op: 200 duplicate, no writes", async () => {
    const delivery = newId();
    const payload = evt(1001, { action: "opened", issue: { number: 1 } });
    expect(await result(await post(payload, { delivery }))).toBe("ok");
    expect(await jobs()).toHaveLength(2);
    await db().job.deleteMany({});
    const stamp = await lastWebhook(1001n);
    const again = await post(payload, { delivery });
    expect(again.status).toBe(200);
    expect(await result(again)).toBe("duplicate");
    expect(await jobs()).toHaveLength(0); // nothing queued the second time, so a manual redelivery after success changes nothing
    expect(await deliveries()).toBe(1);
    expect(await lastWebhook(1001n)).toEqual(stamp);
    const row = await db().githubDelivery.findUniqueOrThrow({ where: { deliveryId: delivery } });
    expect(row).toMatchObject({ installationId: 1001n, event: "issues" });
  });

  it("concurrent deliveries of one id are handled once", async () => {
    const delivery = newId();
    const payload = evt(1001, { action: "opened", issue: { number: 1 } });
    const rs = await Promise.all([post(payload, { delivery }), post(payload, { delivery })]);
    const results = await Promise.all(rs.map(result));
    expect(results.filter((x) => x === "ok")).toHaveLength(1);
    expect(results.filter((x) => x === "duplicate")).toHaveLength(1);
    expect(await jobs()).toHaveLength(2);
  });

  it("a handler failure rolls everything back (no delivery row, no stamp), so redelivery of the same id then succeeds", async () => {
    const delivery = newId();
    const payload = evt(1001, { action: "opened", issue: { number: 1 } });
    spy.enqueue.mockRejectedValueOnce(new Error("queue is down"));
    const failed = await post(payload, { delivery });
    expect(failed.status).toBe(500);
    expect(await deliveries()).toBe(0);
    expect(await lastWebhook(1001n)).toBeNull();
    expect(await jobs()).toHaveLength(0);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);

    const redelivered = await post(payload, { delivery });
    expect(redelivered.status).toBe(200);
    expect(await result(redelivered)).toBe("ok");
    expect(await deliveries()).toBe(1);
    expect(await jobs()).toHaveLength(2);
    expect(await lastWebhook(1001n)).not.toBeNull();
  });

  it("sets lastWebhookAt on an accepted delivery for a known installation, also when no repository matched, and only for that installation", async () => {
    expect(await lastWebhook(1001n)).toBeNull();
    await post(evt(1001, { action: "opened", issue: { number: 1 } }, 55555n), { event: "issues" });
    expect(await lastWebhook(1001n)).not.toBeNull();
    expect(await lastWebhook(2002n)).toBeNull();
  });
});

describe("installation lifecycle", () => {
  const life = (installation: number, action: string) => post({ action, installation: { id: installation } }, { event: "installation" });
  const proofs = () => db().workspaceInstallation.findMany({ select: { workspaceId: true, installationId: true, verifiedAt: true, verifiedGithubUserId: true, proofMethod: true }, orderBy: [{ workspaceId: "asc" }, { installationId: "asc" }] });
  const audits = (action: string) => db().auditLog.findMany({ where: { action, workspaceId: { in: [A, B] } }, orderBy: { workspaceId: "asc" } });

  it("deleted, suspend, unsuspend, created and new_permissions_accepted move the global state; every workspace sees it; audit once per workspace per change", async () => {
    const before = await proofs();
    expect(await connectionState(db(), A)).toBe("ok");

    expect((await life(1001, "suspend")).status).toBe(200);
    expect(await connectionState(db(), A)).toBe("suspended");
    expect((await life(1001, "suspend")).status).toBe(200); // a repeat records nothing more
    expect((await audits("github.installation-suspended")).map((a) => a.workspaceId).sort()).toEqual([A, B].sort());

    await life(1001, "unsuspend");
    expect(await connectionState(db(), A)).toBe("ok");
    expect(await connectionState(db(), B)).toBe("ok");

    await life(1001, "deleted");
    expect(await connectionState(db(), A)).toBe("removed");
    const row = await db().githubInstallation.findUniqueOrThrow({ where: { installationId: 1001n } });
    expect(row.deletedAt).not.toBeNull();
    expect((await audits("github.installation-deleted")).map((a) => a.workspaceId).sort()).toEqual([A, B].sort());
    expect((await audits("github.installation-deleted"))[0].actorUserId).toBeNull();

    await life(1001, "created");
    expect(await connectionState(db(), A)).toBe("ok");
    await life(1001, "deleted");
    await life(1001, "new_permissions_accepted");
    expect(await connectionState(db(), A)).toBe("ok");

    // the other installation and every binding's proof columns are untouched
    expect((await db().githubInstallation.findUniqueOrThrow({ where: { installationId: 2002n } })).deletedAt).toBeNull();
    expect(await proofs()).toEqual(before);
    expect(await db().workspaceInstallation.count()).toBe(3);
    // repositories are untouched by a state change: they work again when the installation does
    expect((await db().repository.findUniqueOrThrow({ where: { id: rA } })).installationId).toBe(1001n);
  });

  it("installation_repositories removed disconnects tracked repositories of THAT installation in every bound workspace, with audit rows", async () => {
    const r = await post({ action: "removed", installation: { id: 1001 }, repositories_removed: [{ id: Number(REPO), full_name: "acme/x" }, { id: 424242 }, { id: "bad" }, null], repositories_added: [] }, { event: "installation_repositories" });
    expect(r.status).toBe(200);
    for (const id of [rA, rB]) {
      const row = await db().repository.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ trackingStatus: "DISCONNECTED", installationId: null });
      expect(row.statusDetail).toBeTruthy();
    }
    // the repository served by the other installation is untouched
    expect(await db().repository.findUniqueOrThrow({ where: { id: rC } })).toMatchObject({ trackingStatus: "ACTIVE", installationId: 2002n });
    const logs = await audits("github.repositories-removed");
    expect(logs.map((l) => l.workspaceId).sort()).toEqual([A, B].sort());
    expect(logs.every((l) => (l.meta as { repositoriesDisconnected: number }).repositoriesDisconnected === 1)).toBe(true);
    // the bindings stay, planning data stays
    expect(await db().workspaceInstallation.count()).toBe(3);
    expect(await db().repository.count()).toBe(3);
  });

  it("removed ids that belong to another installation's repositories change nothing (a forged list)", async () => {
    await post({ action: "removed", installation: { id: 1001 }, repositories_removed: [{ id: Number(OTHER) }] }, { event: "installation_repositories" });
    expect(await db().repository.findUniqueOrThrow({ where: { id: rC } })).toMatchObject({ trackingStatus: "ACTIVE", installationId: 2002n });
    expect(await audits("github.repositories-removed")).toHaveLength(0);
  });

  it("added does nothing (administrators choose what to track) and a REMOVED repository stays REMOVED", async () => {
    await post({ action: "added", installation: { id: 1001 }, repositories_added: [{ id: 999 }] }, { event: "installation_repositories" });
    expect(await jobs()).toHaveLength(0);
    expect(await db().repository.count({ where: { installationId: { not: null } } })).toBe(3);
    await db().repository.updateMany({ where: { id: rA, workspaceId: A }, data: { trackingStatus: "REMOVED" } });
    await post({ action: "removed", installation: { id: 1001 }, repositories_removed: [{ id: Number(REPO) }] }, { event: "installation_repositories" });
    expect((await db().repository.findUniqueOrThrow({ where: { id: rA } })).trackingStatus).toBe("REMOVED");
    expect((await audits("github.repositories-removed")).map((l) => l.workspaceId)).toEqual([B]);
  });
});

describe("maintenance", () => {
  it("prunes delivery ids older than 7 days and app states past their expiry, nothing else", async () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const day = 86_400_000;
    await db().githubDelivery.createMany({
      data: [
        { deliveryId: "old-delivery-1", event: "push", receivedAt: new Date(now.getTime() - 8 * day) },
        { deliveryId: "new-delivery-1", event: "push", receivedAt: new Date(now.getTime() - 6 * day) },
      ],
    });
    const user = (await db().user.findFirstOrThrow()).id;
    await db().githubAppState.createMany({
      data: [
        { stateHash: "expired", userId: user, workspaceId: A, kind: "connect", expiresAt: new Date(now.getTime() - 1000) },
        { stateHash: "used-expired", userId: user, workspaceId: A, kind: "connect", expiresAt: new Date(now.getTime() - day), usedAt: now },
        { stateHash: "fresh", userId: user, workspaceId: B, kind: "connect", expiresAt: new Date(now.getTime() + 60_000) },
      ],
    });
    expect(await pruneGithubAppData(db(), now)).toEqual({ deliveries: 1, states: 2 });
    expect((await db().githubDelivery.findMany()).map((d) => d.deliveryId)).toEqual(["new-delivery-1"]);
    expect((await db().githubAppState.findMany({ where: { workspaceId: { in: [A, B] } } })).map((s) => s.stateHash)).toEqual(["fresh"]);
    expect(await db().githubInstallation.count()).toBe(2);
  });

  it("the scheduler runs it daily as a system job, and the job handler prunes", async () => {
    const { handlers } = await import("@/lib/local/handlers");
    await db().githubDelivery.create({ data: { deliveryId: "ancient-delivery", event: "push", receivedAt: new Date("2020-01-01T00:00:00Z") } });
    await handlers["github.maintenance"](undefined as never, {} as never);
    expect(await db().githubDelivery.count()).toBe(0);
    const { coordinate } = await import("@/lib/local/scheduler");
    await coordinate();
    const j = await db().job.findUnique({ where: { dedupeKey: "github-maintenance" } });
    expect(j).toMatchObject({ type: "github.maintenance", intervalMs: 24 * 3_600_000, workspaceId: null });
  });
});

describe("reconcile pacing", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const min = 60_000;
  const setup = async (o: { webhookAgoMin: number | null; syncedAgoMin: number | null; error?: string; repo?: string; ws?: string }) => {
    await db().githubInstallation.update({ where: { installationId: 1001n }, data: { lastWebhookAt: o.webhookAgoMin === null ? null : new Date(now.getTime() - o.webhookAgoMin * min) } });
    await db().repository.updateMany({ where: { id: o.repo ?? rA, workspaceId: o.ws ?? A }, data: { lastSyncedAt: o.syncedAgoMin === null ? null : new Date(now.getTime() - o.syncedAgoMin * min), syncError: o.error ?? null } });
    await db().job.deleteMany({});
    return enqueueHostedReconcile(db(), o.ws ?? A, now);
  };

  it("a workspace whose installation got a webhook in the last 24 h reconciles about hourly: a sync 30 minutes old is skipped, 58 minutes old runs", async () => {
    expect(await setup({ webhookAgoMin: 30, syncedAgoMin: 30 })).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await setup({ webhookAgoMin: 30, syncedAgoMin: 54 })).toBe(0);
    expect(await setup({ webhookAgoMin: 30, syncedAgoMin: 58 })).toBe(1);
    expect(await jobKeys()).toEqual([`A:sync.repository:sync:${rA}`]);
  });

  it("the safety net stays: silent installations, never-synced, failed or disconnected repositories run on every pass", async () => {
    expect(await setup({ webhookAgoMin: null, syncedAgoMin: 5 })).toBe(1); // no webhook ever
    expect(await setup({ webhookAgoMin: 25 * 60, syncedAgoMin: 5 })).toBe(1); // silent for over a day
    expect(await setup({ webhookAgoMin: 5, syncedAgoMin: null })).toBe(1); // never synced
    expect(await setup({ webhookAgoMin: 5, syncedAgoMin: 5, error: "boom" })).toBe(1); // last sync failed
    await db().repository.updateMany({ where: { id: rA, workspaceId: A }, data: { syncError: null, trackingStatus: "DISCONNECTED" } });
    await db().job.deleteMany({});
    expect(await enqueueHostedReconcile(db(), A, now)).toBe(1); // disconnected: re-checked so a restored access is noticed
  });

  it("is per workspace and per installation: B's repository on the silent installation 2002 still runs while 1001's is skipped", async () => {
    await db().githubInstallation.update({ where: { installationId: 1001n }, data: { lastWebhookAt: new Date(now.getTime() - 5 * min) } });
    await db().repository.updateMany({ where: { workspaceId: B }, data: { lastSyncedAt: new Date(now.getTime() - 10 * min), syncError: null } });
    await db().job.deleteMany({});
    expect(await enqueueHostedReconcile(db(), B, now)).toBe(1);
    expect(await jobKeys()).toEqual([`B:sync.repository:sync:${rC}`]);
  });
});

describe("perimeter: proxy exemption and rate limits", () => {
  const proxyAt = async (host: string, path: string, init: { method?: string; origin?: string; site?: string } = {}) => {
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(`https://${host}${path}`, { method: init.method ?? "GET", headers: { host, ...(init.origin ? { origin: init.origin } : {}), ...(init.site ? { "sec-fetch-site": init.site } : {}) } }));
  };

  it("exempts exactly POST /api/github/webhook from the Origin rule, on a hosted deployment", async () => {
    expect((await proxyAt("app.test", "/api/github/webhook", { method: "POST" })).status).toBe(200); // no Origin, no Sec-Fetch-Site
    expect((await proxyAt("app.test", "/api/github/webhook", { method: "POST", origin: "https://evil.example", site: "cross-site" })).status).toBe(200);
    // anything else keeps the rule
    for (const [path, method] of [
      ["/api/github/webhook/", "POST"],
      ["/api/github/webhook2", "POST"],
      ["/api/github/webhookx", "POST"],
      ["/api/github/app/callback", "POST"],
      ["/api/github/webhook", "PUT"],
      ["/api/github/webhook", "DELETE"],
      ["/api/github/webhook", "PATCH"],
      ["/settings/github", "POST"],
    ] as const) {
      expect((await proxyAt("app.test", path, { method })).status, `${method} ${path}`).toBe(403);
    }
  });

  it("does not exempt it on a local (not hosted) app", async () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    expect((await proxyAt("127.0.0.1:3000", "/api/github/webhook", { method: "POST" })).status).toBe(403);
    expect((await proxyAt("127.0.0.1:3000", "/api/federation/v1/token", { method: "POST" })).status).toBe(403);
  });

  it("the route never reads a cookie or a session", async () => {
    state.jar.set("mp_session", { value: "whatever", options: {} });
    const r = await post({ zen: "x" }, { event: "ping" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("limits invalid signatures per address to 30 a minute (429 after), without affecting another address", async () => {
    const body = JSON.stringify({ zen: "x" });
    for (let i = 0; i < 30; i++) expect((await post(body, { event: "ping", sig: sign(body, "nope"), ip: "198.51.100.9" })).status).toBe(401);
    expect((await post(body, { event: "ping", sig: sign(body, "nope"), ip: "198.51.100.9" })).status).toBe(429);
    expect((await post(body, { event: "ping", sig: sign(body, "nope"), ip: "198.51.100.10" })).status).toBe(401);
    // a valid signature from the blocked address is not caught by the brute-force counter
    expect((await post(body, { event: "ping", ip: "198.51.100.9" })).status).toBe(200);
  });

  it("limits requests per address to 600 a minute (429 after)", async () => {
    const hash = createHash("sha256").update("198.51.100.77").digest("hex").slice(0, 24);
    await db().rateLimitState.create({ data: { key: `ghwh:ip:${hash}`, remaining: 0, limit: 600, resetAt: new Date(Date.now() + 60_000) } });
    expect((await post({ zen: "x" }, { event: "ping", ip: "198.51.100.77" })).status).toBe(429);
    expect((await post({ zen: "x" }, { event: "ping", ip: "198.51.100.78" })).status).toBe(200);
  });

  it("the counters hold a hash of the address, not the address", async () => {
    await post({ zen: "x" }, { event: "ping", ip: "198.51.100.123" });
    const keys = (await db().rateLimitState.findMany({ where: { key: { startsWith: "ghwh:" } } })).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join()).not.toContain("198.51.100.123");
  });
});
