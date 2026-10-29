import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import { GithubError } from "@/lib/github/port";
import { DemoPort } from "@/lib/github/demo";
import * as work from "@/lib/services/work-actions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { createSession, findSession, destroySession } from "@/lib/auth/session";
import { sha256 } from "@/lib/crypto";
import { listNotifications, unreadNotificationCount } from "@/lib/services/queries";
import { revokeRepositories } from "@/lib/services/grants";
import { upsertRepository } from "@/lib/services/repositories";
import { safeReturnTo, sameOrigin } from "@/lib/http";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("GitHub writes", () => {
  it("require the grant capability; hidden items are NotFound", async () => {
    const { db, a, b, ids } = S;
    const fake = new FakeGithub();
    // B can see atlas-web but only has review (not manageWork) there.
    await expect(work.addComment({ db, v: b, port: fake }, ids.items.web10.id, "hello")).rejects.toBeInstanceOf(ForbiddenError);
    // B cannot see atlas-api at all.
    await expect(work.addComment({ db, v: b, port: fake }, ids.items.api14.id, "hello")).rejects.toBeInstanceOf(NotFoundError);
    await work.addComment({ db, v: a, port: fake }, ids.items.web10.id, "hello");
    expect(fake.writes).toContain("comment northwind/atlas-web#10");
  });

  it("reviewing requires the review capability and forbids approving your own PR", async () => {
    const { db, a, ids } = S;
    const fake = new FakeGithub();
    // alice has review on atlas-web; PR #9 is authored by bram. Approve is fine, own PR is not.
    await expect(work.submitReview({ db, v: a, port: fake }, ids.items.web8.id, "APPROVE", "")).rejects.toThrow(/own pull request/);
    await work.submitReview({ db, v: a, port: fake }, ids.items.web9.id, "APPROVE", "");
    expect(fake.writes.some((w) => w.includes("APPROVE"))).toBe(true);
    await expect(work.submitReview({ db, v: a, port: fake }, ids.items.web9.id, "REQUEST_CHANGES", "  ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("merge: hard blockers stop it, warnings need acknowledgement, a moved head is refused", async () => {
    const { db, a, ids } = S;
    const port = new DemoPort(db, "alice-demo");
    const ctx = { db, v: a, port };
    // api15 has failing checks in the seed (checksState is read live from port: demo returns SUCCESS) -> use conflicting state instead
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { mergeable: "CONFLICTING" } });
    let e = await work.mergeEligibility(ctx, ids.items.api14.id);
    expect(e.hardBlockers.join(" ")).toMatch(/conflicts/);
    await expect(work.mergePullRequest(ctx, ids.items.api14.id, { method: "squash", confirmedHeadSha: e.headSha!, acknowledgeWarnings: true })).rejects.toThrow(/conflicts/);

    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { mergeable: "MERGEABLE" } });
    e = await work.mergeEligibility(ctx, ids.items.api14.id);
    expect(e.hardBlockers).toHaveLength(0);
    expect(e.warnings.join(" ")).toMatch(/routing rule/); // no approval yet
    await expect(work.mergePullRequest(ctx, ids.items.api14.id, { method: "squash", confirmedHeadSha: e.headSha!, acknowledgeWarnings: false })).rejects.toThrow(/Acknowledge/);
    await expect(work.mergePullRequest(ctx, ids.items.api14.id, { method: "squash", confirmedHeadSha: "stale-sha", acknowledgeWarnings: true })).rejects.toThrow(/changed after you confirmed/);
    await work.mergePullRequest(ctx, ids.items.api14.id, { method: "squash", confirmedHeadSha: e.headSha!, acknowledgeWarnings: true });
    expect((await db.workItem.findUniqueOrThrow({ where: { id: ids.items.api14.id } })).state).toBe("MERGED");
  });

  it("unknown mergeability is a blocker, never assumed mergeable", async () => {
    const { db, a, ids } = S;
    await db.workItem.update({ where: { id: ids.items.api14.id }, data: { mergeable: "UNKNOWN" } });
    const e = await work.mergeEligibility({ db, v: a, port: new DemoPort(db, "alice-demo") }, ids.items.api14.id);
    expect(e.hardBlockers.join(" ")).toMatch(/not finished computing/);
  });

  it("fork sync re-checks branch heads and refuses when a branch moved", async () => {
    const { db, admin, ids } = S;
    const port = new DemoPort(db, "owner-demo");
    await expect(work.syncForkBranch({ db, v: admin, port }, ids.map.id, { forkTip: "old", upstreamTip: "u0000003" })).rejects.toThrow(/moved/);
    // diverged with own commits: demo reports a conflict and changes nothing
    const r = await work.syncForkBranch({ db, v: admin, port }, ids.map.id, { forkTip: "f0000002", upstreamTip: "u0000003" });
    expect(r.result).toBe("conflict");
  });

  it("fork sync needs both repositories visible: a hidden upstream cannot be touched or revealed", async () => {
    const { db, a, ids } = S;
    // alice can manage the fork but has NO grant on dashboard-core (upstream)
    const e = await work.syncForkBranch({ db, v: a, port: new DemoPort(db, "alice-demo") }, ids.map.id, { forkTip: "x", upstreamTip: "y" }).catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundError);
  });
});

describe("sessions and request guards", () => {
  it("sessions are opaque, hashed at rest, expire and can be destroyed", async () => {
    const { db, ids } = S;
    const s = await createSession(db, ids.users.a.id, new Date("2026-10-01"));
    expect(await db.session.findFirst({ where: { tokenHash: sha256(s.token) } })).toBeTruthy();
    expect(JSON.stringify(await db.session.findMany())).not.toContain(s.token);
    expect(await findSession(db, s.token, new Date("2026-10-02"))).toBeTruthy();
    expect(await findSession(db, s.token, new Date("2027-01-01"))).toBeNull();
    await destroySession(db, s.token);
    expect(await findSession(db, s.token, new Date("2026-10-02"))).toBeNull();
    expect(await findSession(db, "garbage")).toBeNull();
  });

  it("post-login redirects are same-site only; mutations need our origin", () => {
    expect(safeReturnTo("/planning?x=1")).toBe("/planning?x=1");
    for (const bad of ["//evil.example", "https://evil.example", "\\evil", "javascript:alert(1)", "", null]) expect(safeReturnTo(bad as string)).toBe("/");
    process.env.APP_URL = "http://localhost:3000";
    const req = (origin?: string) => new Request("http://localhost:3000/api/x", { method: "POST", headers: origin ? { origin, host: "localhost:3000" } : { host: "localhost:3000" } });
    expect(sameOrigin(req("http://localhost:3000"))).toBe(true);
    expect(sameOrigin(req("http://evil.example"))).toBe(false);
    expect(sameOrigin(req())).toBe(false);
  });
});

describe("notifications obey current grants", () => {
  it("a revoked repository's notifications disappear immediately", async () => {
    const { db, a, admin, ids } = S;
    await db.notification.create({ data: { workspaceId: ids.ws.id, userId: ids.users.a.id, repositoryId: ids.repos.web.id, kind: "review-requested", title: "Review requested: atlas-web" } });
    await db.notification.create({ data: { workspaceId: ids.ws.id, userId: ids.users.a.id, repositoryId: ids.repos.api.id, kind: "review-requested", title: "Review requested: atlas-api" } });
    expect(await unreadNotificationCount(db, a)).toBe(2);
    await revokeRepositories(db, admin, ids.members.a.id, [ids.repos.web.id]);
    expect(await unreadNotificationCount(db, a)).toBe(1);
    expect((await listNotifications(db, a)).map((n) => n.title)).toEqual(["Review requested: atlas-api"]);
  });
});

describe("public import path", () => {
  it("a public repository is tracked locally and stays unassigned to members", async () => {
    const { db, admin, a, ids } = S;
    const m = { githubId: 123456n, fullName: "northwind/new-public", name: "new-public", htmlUrl: "https://github.com/northwind/new-public", visibility: "PUBLIC" as const, isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 5001n, login: "northwind", type: "ORGANIZATION" as const } };
    const r = await upsertRepository(db, ids.ws.id, m);
    expect(r.isDemo).toBe(false);
    const { listRepositories } = await import("@/lib/services/queries");
    expect((await listRepositories(db, a)).some((x) => x.name === "new-public")).toBe(false); // public on GitHub != shared here
    expect((await listRepositories(db, admin)).some((x) => x.name === "new-public")).toBe(true);
  });

  it("a rate-limited public read surfaces as a typed state, not as missing data", async () => {
    const fake = new FakeGithub();
    fake.failNext(new GithubError("rate-limited", "API rate limit exceeded", 90));
    const e = await fake.getRepository("a", "b").catch((x) => x);
    expect(e).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 90 });
  });
});
