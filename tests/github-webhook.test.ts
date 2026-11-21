import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, state } from "./auth-mocks";
import { workspaceWithOwner } from "./roles-helpers";
import { hostedGithub, releaseApp, useApp } from "./github-hosted-helpers";
import { listWorkspaceInstallations, setRepositoryInstallation } from "@/lib/github/binding";
import { pruneGithubAppData } from "@/lib/github/webhook-maintenance";
import { enqueueHostedReconcile } from "@/lib/github/webhook-pacing";
import { MAX_REMOVED_IDS, repositoryIds } from "@/lib/github/webhook-lifecycle";
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
let gh: ReturnType<typeof hostedGithub>;

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
  gh = hostedGithub();
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

  it("stamps lastWebhookAt for an item or repository event of a known installation (also when no repository matched), only that installation, never for ping or lifecycle events", async () => {
    expect(await lastWebhook(1001n)).toBeNull();
    await post({ zen: "x" }, { event: "ping" });
    await post({ action: "suspend", installation: { id: 1001 } }, { event: "installation" });
    expect(await lastWebhook(1001n)).toBeNull();
    await post(evt(1001, { action: "opened", issue: { number: 1 } }, 55555n), { event: "issues" });
    expect(await lastWebhook(1001n)).not.toBeNull();
    expect(await lastWebhook(2002n)).toBeNull();
  });

  it("stamps lastEventAt on the repository rows an event maps to (not others), at most once a minute", async () => {
    const at = async (id: string, ws: string) => (await db().repository.findFirstOrThrow({ where: { id, workspaceId: ws } })).lastEventAt;
    await post(evt(1001, { action: "opened", issue: { number: 1 } }), { event: "issues" });
    const first = await at(rA, A);
    expect(first).not.toBeNull();
    expect(await at(rB, B)).not.toBeNull();
    expect(await at(rC, B)).toBeNull();
    await post(evt(1001, { action: "edited", issue: { number: 1 } }), { event: "issues" }); // within the minute: the row is not written again
    expect(await at(rA, A)).toEqual(first);
    await db().repository.updateMany({ where: { id: rA, workspaceId: A }, data: { lastEventAt: new Date(Date.now() - 5 * 60_000) } });
    await post(evt(1001, { action: "edited", issue: { number: 2 } }), { event: "issues" });
    expect((await at(rA, A))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("parallel deliveries for the same not-yet-queued item all succeed and leave exactly one job per workspace (no transaction to abort)", async () => {
    const payload = (a: string) => evt(1001, { action: a, pull_request: { number: 9 } });
    const rs = await Promise.all(["opened", "synchronize", "edited", "labeled", "reopened", "assigned"].map((a) => post(payload(a), { event: "pull_request" })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await jobKeys()).toEqual([`A:sync.item:item:${rA}:9`, `B:sync.item:item:${rB}:9`]);
    expect(await deliveries()).toBe(6);
  });

  it("queueing that fails AFTER the delivery was recorded removes the delivery row again, so redelivery of the same id works", async () => {
    const delivery = newId();
    const payload = evt(1001, { action: "opened", issue: { number: 3 } });
    const real = spy.enqueue.getMockImplementation()!;
    spy.enqueue.mockImplementationOnce(real).mockRejectedValueOnce(new Error("second job failed")); // the first job is queued, the second fails
    const failed = await post(payload, { delivery });
    expect(failed.status).toBe(500);
    expect(await deliveries()).toBe(0);
    expect(await lastWebhook(1001n)).toBeNull();
    expect((await post(payload, { delivery })).status).toBe(200);
    expect(await deliveries()).toBe(1);
    expect(await jobs()).toHaveLength(2); // the job queued before the failure is coalesced with the redelivery's
  });
});

describe("installation lifecycle (GitHub is asked, the event's action word is not trusted)", () => {
  let LIVE: bigint;
  let fi: ReturnType<typeof gh.server.addInstallation>;
  const lifeJobs = () => db().job.findMany({ where: { type: "github.installation.check" }, orderBy: { dedupeKey: "asc" } });
  const runCheck = async (id: bigint = LIVE) => {
    const { handlers } = await import("@/lib/local/handlers");
    await handlers["github.installation.check"]({ installationId: String(id) } as never, {} as never);
  };
  const life = (installation: bigint | number, action: string, event = "installation") => post({ action, installation: { id: Number(installation) } }, { event });
  const proofs = () => db().workspaceInstallation.findMany({ select: { workspaceId: true, installationId: true, verifiedAt: true, verifiedGithubUserId: true, proofMethod: true }, orderBy: [{ workspaceId: "asc" }, { installationId: "asc" }] });
  const audits = (action: string) => db().auditLog.findMany({ where: { action, workspaceId: { in: [A, B] } }, orderBy: { workspaceId: "asc" } });
  /** What Settings shows for the live installation in a workspace. */
  const statusIn = async (ws: string) => (await listWorkspaceInstallations(db(), ws)).find((r) => r.installationId === LIVE)!.status;
  const stateOf = async () => {
    const r = await db().githubInstallation.findUniqueOrThrow({ where: { installationId: LIVE } });
    return r.deletedAt ? "deleted" : r.suspendedAt ? "suspended" : "active";
  };

  beforeEach(async () => {
    fi = gh.server.addInstallation("acme");
    LIVE = BigInt(fi.id);
    await installation(LIVE, "acme");
    await bindTo(A, LIVE);
    await bindTo(B, LIVE);
  });

  it("a lifecycle event only queues one deduplicated check job per installation: no state flips, no stamp, no GitHub call", async () => {
    gh.server.calls.length = 0;
    for (const action of ["suspend", "unsuspend", "deleted", "created", "new_permissions_accepted", "whatever"]) expect((await life(LIVE, action)).status).toBe(200);
    expect(await stateOf()).toBe("active");
    expect(await audits("github.installation-suspended")).toHaveLength(0);
    const queued = await lifeJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ dedupeKey: `ghinst:${LIVE}`, workspaceId: null, status: "QUEUED", payload: { installationId: String(LIVE) } });
    expect((await db().githubInstallation.findUniqueOrThrow({ where: { installationId: LIVE } })).lastWebhookAt).toBeNull();
    expect(gh.server.calls).toHaveLength(0);
  });

  it("jobs are isolated per installation", async () => {
    await life(LIVE, "suspend");
    await life(1001, "suspend");
    expect((await lifeJobs()).map((j) => j.dedupeKey)).toEqual([`ghinst:1001`, `ghinst:${LIVE}`].sort());
  });

  it("out-of-order events end in the state GitHub reports: a late `suspend` after an `unsuspend` leaves it active", async () => {
    const before = await proofs();
    fi.suspended = true;
    await life(LIVE, "suspend");
    await runCheck();
    expect(await stateOf()).toBe("suspended");
    expect(await statusIn(A)).toBe("suspended");
    expect((await audits("github.installation-suspended")).map((a) => a.workspaceId).sort()).toEqual([A, B].sort());

    fi.suspended = false; // GitHub unsuspended; then a LATE `suspend` delivery arrives
    await life(LIVE, "unsuspend");
    await life(LIVE, "suspend");
    await runCheck();
    expect(await stateOf()).toBe("active");
    expect(await statusIn(B)).toBe("active");
    expect((await audits("github.installation-active")).map((a) => a.workspaceId).sort()).toEqual([A, B].sort());

    await life(LIVE, "suspend"); // late and wrong, GitHub still says active: nothing changes, no audit
    await runCheck();
    expect(await stateOf()).toBe("active");
    expect(await audits("github.installation-active")).toHaveLength(2);
    expect(await audits("github.installation-suspended")).toHaveLength(2);
    expect(await proofs()).toEqual(before);
  });

  it("deleted and created follow GitHub too (404 = deleted; present again = active), audit once per real change", async () => {
    gh.server.installations.delete(fi.id);
    await life(LIVE, "deleted");
    await runCheck();
    expect(await stateOf()).toBe("deleted");
    expect(await statusIn(A)).toBe("removed");
    await runCheck(); // asked again, same answer: no second audit
    expect(await audits("github.installation-deleted")).toHaveLength(2);

    await life(LIVE, "created"); // a late `created` while GitHub still says gone
    await runCheck();
    expect(await stateOf()).toBe("deleted");

    gh.server.installations.set(fi.id, fi);
    await life(LIVE, "created");
    await runCheck();
    expect(await stateOf()).toBe("active");
    expect(await db().workspaceInstallation.count({ where: { installationId: LIVE } })).toBe(2); // bindings stay
  });

  it("a check for an installation we do not hold, or a job with a junk payload, writes nothing", async () => {
    const { handlers } = await import("@/lib/local/handlers");
    await handlers["github.installation.check"]({ installationId: "999999" } as never, {} as never);
    await handlers["github.installation.check"]({ installationId: "x; drop" } as never, {} as never);
    expect(await db().githubInstallation.count()).toBe(3);
  });

  it("installation_repositories: removed queues the check plus a refresh per tracked repository, and disconnects nothing itself", async () => {
    const r = await post({ action: "removed", installation: { id: 1001 }, repositories_removed: [{ id: Number(REPO) }, { id: 424242 }, { id: "bad" }, null] }, { event: "installation_repositories" });
    expect(r.status).toBe(200);
    const got = await jobs();
    expect(got.filter((j) => j.type === "sync.repository").map((j) => `${j.workspaceId === A ? "A" : "B"}:${j.dedupeKey}`).sort()).toEqual([`A:sync:${rA}`, `B:sync:${rB}`]);
    expect(got.filter((j) => j.type === "github.installation.check")).toHaveLength(1);
    for (const id of [rA, rB]) expect(await db().repository.findUniqueOrThrow({ where: { id } })).toMatchObject({ trackingStatus: "ACTIVE", installationId: 1001n });
    expect(await db().workspaceInstallation.count()).toBe(5);
  });

  it("removed ids that belong to another installation's repositories queue no refresh (a forged list), and `added` only queues the check", async () => {
    await post({ action: "removed", installation: { id: 1001 }, repositories_removed: [{ id: Number(OTHER) }] }, { event: "installation_repositories" });
    await post({ action: "added", installation: { id: 1001 }, repositories_added: [{ id: Number(REPO) }] }, { event: "installation_repositories" });
    expect((await jobs()).map((j) => j.type)).toEqual(["github.installation.check"]);
  });

  it("removed then added ends connected: the refresh finds the repository still readable, and the check says active", async () => {
    const pub = await gh.create("pub", false);
    void pub;
    fi.repos.add("acme/pub");
    const ghRepo = (await (await gh.server.fetchFor("acme-owner")("https://api.github.com/repos/acme/pub")).json()) as { id: number };
    const owner = await db().githubOwner.upsert({ where: { githubId: 9001n }, create: { githubId: 9001n, login: "acme", type: "ORGANIZATION" }, update: {} });
    const repo = await db().repository.create({ data: { workspaceId: A, githubId: BigInt(ghRepo.id), ownerId: owner.id, name: "pub", fullName: "acme/pub", htmlUrl: "https://github.com/acme/pub" } });
    await setRepositoryInstallation(db(), A, repo.id, LIVE);
    const { handlers } = await import("@/lib/local/handlers");
    const sync = async () => handlers["sync.repository"]({ repositoryId: repo.id } as never, { workspaceId: A } as never);

    await life(LIVE, "removed", "installation_repositories"); // junk action word: ignored, still just a check
    await post({ action: "removed", installation: { id: fi.id }, repositories_removed: [{ id: ghRepo.id }] }, { event: "installation_repositories" });
    await post({ action: "added", installation: { id: fi.id }, repositories_added: [{ id: ghRepo.id }] }, { event: "installation_repositories" });
    await runCheck();
    await sync();
    expect(await db().repository.findUniqueOrThrow({ where: { id: repo.id } })).toMatchObject({ trackingStatus: "ACTIVE", installationId: LIVE });
    expect(await stateOf()).toBe("active");
  });

  it("a repository GitHub really removed from the installation answers 404 in its refresh job and becomes DISCONNECTED (the existing path)", async () => {
    await gh.create("gone", false);
    fi.repos.add("acme/gone");
    const ghRepo = (await (await gh.server.fetchFor("acme-owner")("https://api.github.com/repos/acme/gone")).json()) as { id: number };
    const owner = await db().githubOwner.upsert({ where: { githubId: 9001n }, create: { githubId: 9001n, login: "acme", type: "ORGANIZATION" }, update: {} });
    const repo = await db().repository.create({ data: { workspaceId: A, githubId: BigInt(ghRepo.id), ownerId: owner.id, name: "gone", fullName: "acme/gone", htmlUrl: "https://github.com/acme/gone" } });
    await setRepositoryInstallation(db(), A, repo.id, LIVE);
    fi.repos.delete("acme/gone"); // GitHub: removed from the installation
    await post({ action: "removed", installation: { id: fi.id }, repositories_removed: [{ id: ghRepo.id }] }, { event: "installation_repositories" });
    const queued = (await jobs()).find((j) => j.type === "sync.repository" && j.workspaceId === A);
    expect(queued).toBeTruthy();
    const { handlers } = await import("@/lib/local/handlers");
    await expect(handlers["sync.repository"](queued!.payload as never, queued as never)).rejects.toThrow();
    expect(await db().repository.findUniqueOrThrow({ where: { id: repo.id } })).toMatchObject({ trackingStatus: "DISCONNECTED" });
  });

  it("a large removal is chunked, not sliced: 1500 tracked repositories each get a refresh", async () => {
    const owner = await db().githubOwner.upsert({ where: { githubId: 9001n }, create: { githubId: 9001n, login: "acme", type: "ORGANIZATION" }, update: {} });
    const ids = Array.from({ length: 1500 }, (_, i) => 50_000 + i);
    await db().repository.createMany({ data: ids.map((g) => ({ workspaceId: A, githubId: BigInt(g), ownerId: owner.id, name: `m${g}`, fullName: `acme/m${g}`, htmlUrl: "https://github.com/acme/m", installationId: 1001n })) });
    const r = await post({ action: "removed", installation: { id: 1001 }, repositories_removed: ids.map((g) => ({ id: g })) }, { event: "installation_repositories" });
    expect(r.status).toBe(200);
    expect(await db().job.count({ where: { type: "sync.repository", workspaceId: A } })).toBe(1500);
    expect(await db().job.count({ where: { type: "reconcile.all" } })).toBe(0); // under the cap: no hint needed
  }, 120_000);

  it("repositoryIds caps one delivery at 2000 ids, flags the rest, and drops junk", () => {
    const list = [...Array.from({ length: 2500 }, (_, i) => ({ id: i + 1 })), { id: -4 }, { id: "x" }, null];
    const r = repositoryIds(list);
    expect(r.ids).toHaveLength(MAX_REMOVED_IDS);
    expect(r.truncated).toBe(true);
    expect(repositoryIds([{ id: 1 }, { id: 1 }, { id: 2 }])).toEqual({ ids: [1n, 2n], truncated: false });
    expect(repositoryIds("nope")).toEqual({ ids: [], truncated: false });
  });
});

describe("maintenance", () => {
  it("prunes delivery ids older than 7 days, app states past their expiry and expired counters, in batches, nothing else", async () => {
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
    // more than one batch of each (1000 per statement): 1200 old deliveries, 1500 expired counters
    await db().githubDelivery.createMany({ data: Array.from({ length: 1200 }, (_, i) => ({ deliveryId: `bulk-delivery-${i}`, event: "push", receivedAt: new Date(now.getTime() - 9 * day) })) });
    const past = new Date(now.getTime() - 1000);
    await db().rateLimitState.createMany({
      data: [
        ...Array.from({ length: 1500 }, (_, i) => ({ key: `ghwh:bad:expired${i}`, remaining: 0, limit: 30, resetAt: past })),
        { key: "ghwh:bad:fresh", remaining: 3, limit: 30, resetAt: new Date(now.getTime() + 60_000) },
        { key: "installation:77", remaining: 0, limit: 5000, resetAt: past },
        { key: "source", remaining: 0, limit: 5000, resetAt: past },
      ],
    });
    expect(await pruneGithubAppData(db(), now)).toEqual({ deliveries: 1201, states: 2, counters: 1500 });
    expect((await db().rateLimitState.findMany({ where: { NOT: { key: { startsWith: "ws:" } } }, orderBy: { key: "asc" } })).map((r) => r.key)).toEqual(["ghwh:bad:fresh", "installation:77", "source"]);
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
  const setup = async (o: { eventAgoMin: number | null; syncedAgoMin: number | null; error?: string; ws?: string; repo?: string }) => {
    await db().repository.updateMany({
      where: { id: o.repo ?? rA, workspaceId: o.ws ?? A },
      data: { lastEventAt: o.eventAgoMin === null ? null : new Date(now.getTime() - o.eventAgoMin * min), lastSyncedAt: o.syncedAgoMin === null ? null : new Date(now.getTime() - o.syncedAgoMin * min), syncError: o.error ?? null },
    });
    await db().job.deleteMany({});
    return enqueueHostedReconcile(db(), o.ws ?? A, now);
  };

  it("a repository that an event named in the last 24 h reconciles about hourly: a sync 30 minutes old is skipped, 58 minutes old runs", async () => {
    expect(await setup({ eventAgoMin: 30, syncedAgoMin: 30 })).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await setup({ eventAgoMin: 30, syncedAgoMin: 54 })).toBe(0);
    expect(await setup({ eventAgoMin: 30, syncedAgoMin: 58 })).toBe(1);
    expect(await jobKeys()).toEqual([`A:sync.repository:sync:${rA}`]);
  });

  it("the safety net stays: silent repositories, never-synced, failed or disconnected ones run on every pass", async () => {
    expect(await setup({ eventAgoMin: null, syncedAgoMin: 5 })).toBe(1); // no event ever
    expect(await setup({ eventAgoMin: 25 * 60, syncedAgoMin: 5 })).toBe(1); // silent for over a day
    expect(await setup({ eventAgoMin: 5, syncedAgoMin: null })).toBe(1); // never synced
    expect(await setup({ eventAgoMin: 5, syncedAgoMin: 5, error: "boom" })).toBe(1); // last sync failed
    await db().repository.updateMany({ where: { id: rA, workspaceId: A }, data: { syncError: null, trackingStatus: "DISCONNECTED" } });
    await db().job.deleteMany({});
    expect(await enqueueHostedReconcile(db(), A, now)).toBe(1); // disconnected: re-checked so a restored access is noticed
  });

  it("is per repository, not per installation: a busy repository is skipped while a quiet one of the same installation still runs", async () => {
    const other = await track(B, 300n, 1001n);
    await db().repository.updateMany({ where: { workspaceId: B }, data: { lastSyncedAt: new Date(now.getTime() - 10 * min), syncError: null } });
    await db().repository.updateMany({ where: { id: rB, workspaceId: B }, data: { lastEventAt: new Date(now.getTime() - 5 * min) } });
    await db().job.deleteMany({});
    expect(await enqueueHostedReconcile(db(), B, now)).toBe(2); // rC (other installation) and `other` (no event); rB skipped
    expect((await jobs()).map((j) => j.dedupeKey).sort()).toEqual([`sync:${other}`, `sync:${rC}`].sort());
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

  it("never answers a validly signed delivery with 429, even from an address whose invalid-signature budget is spent", async () => {
    const hash = createHash("sha256").update("198.51.100.77").digest("hex").slice(0, 24);
    await db().rateLimitState.create({ data: { key: `ghwh:bad:${hash}`, remaining: 0, limit: 30, resetAt: new Date(Date.now() + 60_000) } });
    const r = await post(evt(1001, { action: "opened", issue: { number: 1 } }), { ip: "198.51.100.77" });
    expect(r.status).toBe(200);
  });

  it("works without a trusted proxy header: signed deliveries from many installations are never limited by a shared address bucket", async () => {
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "");
    for (let i = 0; i < 12; i++) expect((await post(evt(i % 2 ? 1001 : 2002, { action: "opened", issue: { number: i + 1 } }, i % 2 ? REPO : OTHER), { headers: { "x-forwarded-for": "" } })).status).toBe(200);
    expect(await db().rateLimitState.count({ where: { key: { startsWith: "ghwh:ip:" } } })).toBe(0);
  });

  it("sheds a flood from ONE installation (202, nothing queued, no stamp) without touching another installation", async () => {
    await db().rateLimitState.create({ data: { key: "ghwh:inst:1001", remaining: 0, limit: 3000, resetAt: new Date(Date.now() + 60_000) } });
    const shed = await post(evt(1001, { action: "opened", issue: { number: 1 } }), { event: "issues" });
    expect(shed.status).toBe(202);
    expect(await result(shed)).toBe("shed");
    expect(await jobs()).toHaveLength(0);
    expect(await deliveries()).toBe(0);
    expect(await lastWebhook(1001n)).toBeNull();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("shed");
    expect((await post(evt(2002, { action: "opened", issue: { number: 1 } }, OTHER), { event: "issues" })).status).toBe(200);
    expect(await jobs()).toHaveLength(1);
  });

  it("the counters hold a hash of the address, not the address", async () => {
    await post({ zen: "x" }, { event: "ping", ip: "198.51.100.123", sig: sign("x", "nope") });
    const keys = (await db().rateLimitState.findMany({ where: { key: { startsWith: "ghwh:" } } })).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join()).not.toContain("198.51.100.123");
  });
});
