import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayStart, digestDue, localHour, parseDigestSettings, reportedDay, shiftDay } from "@/lib/domain/digest";
import { indexList } from "@/lib/domain/text-index";
import { handlers } from "@/lib/local/handlers";
import { enqueue, runOne } from "@/lib/jobs";
import { buildDigest, generateDigest, getDigest, latestDigest, listDigestDays, markDigestRead, registerDigestSource, runDailyDigest, unreadDigestCount, type DigestEntry } from "@/lib/services/digest";
import { getPrefs, setPrefs } from "@/lib/services/notification-prefs";
import { freshSeed } from "./helpers";

const mocks = vi.hoisted(() => ({ viewer: null as null | Record<string, unknown> }));
vi.mock("@/lib/auth/current", () => ({ requireViewer: async () => ({ user: { githubId: 1n, login: "alice-demo", name: "Alice" }, viewer: mocks.viewer, csrf: "x" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ usePathname: () => "/digest", useRouter: () => ({ push: () => {}, refresh: () => {} }), redirect: () => {}, unstable_rethrow: () => {} }));

// The seed is anchored at 2026-10-28 12:00 UTC. "Now" is the next morning, so the reported day is 2026-10-28 (UTC viewers).
const NOW = new Date("2026-10-29T09:00:00Z");
const DAY = "2026-10-28";
const at = (s: string) => new Date(s);

describe("digest calendar (pure)", () => {
  it("reports the previous local day with exact window edges", () => {
    const r = reportedDay(NOW, "UTC");
    expect(r.day).toBe(DAY);
    expect(r.start.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("follows the person's zone: the same instant is a different local day", () => {
    const now = new Date("2026-10-29T01:00:00Z"); // 14:00 on the 29th in Auckland (UTC+13), 18:00 on the 28th in Los Angeles
    expect(reportedDay(now, "Pacific/Auckland").day).toBe("2026-10-28");
    expect(reportedDay(now, "America/Los_Angeles").day).toBe("2026-10-27");
    expect(reportedDay(now, "Pacific/Auckland").start.toISOString()).toBe("2026-10-27T11:00:00.000Z");
    expect(reportedDay(now, "America/Los_Angeles").end.toISOString()).toBe("2026-10-28T07:00:00.000Z");
  });

  it("a day is 23 hours at spring-forward and 25 at fall-back, never a fixed 24", () => {
    const spring = reportedDay(new Date("2026-03-09T12:00:00Z"), "America/Los_Angeles");
    expect(spring.day).toBe("2026-03-08");
    expect(spring.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = reportedDay(new Date("2026-11-02T12:00:00Z"), "America/Los_Angeles");
    expect(fall.day).toBe("2026-11-01");
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
    const berlin = reportedDay(new Date("2026-10-26T12:00:00Z"), "Europe/Berlin"); // Berlin falls back on 2026-10-25
    expect(berlin.day).toBe("2026-10-25");
    expect(berlin.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(berlin.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("calendar arithmetic crosses month and year ends; an unknown zone counts as UTC", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayStart("2026-10-28", "Not/AZone").toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(localHour(new Date("2026-10-29T09:30:00Z"), "UTC")).toBe(9);
  });

  it("is due only when enabled, the hour has passed and the day has no digest yet", () => {
    const s = parseDigestSettings(undefined);
    expect(s).toEqual({ enabled: true, hour: 8 });
    const base = { tz: "UTC", settings: s, haveDay: false };
    expect(digestDue({ ...base, now: new Date("2026-10-29T07:59:00Z") })).toBe(false);
    expect(digestDue({ ...base, now: new Date("2026-10-29T08:00:00Z") })).toBe(true);
    expect(digestDue({ ...base, now: new Date("2026-10-29T23:00:00Z") })).toBe(true); // the catch-up case
    expect(digestDue({ ...base, now: new Date("2026-10-29T09:00:00Z"), haveDay: true })).toBe(false);
    expect(digestDue({ ...base, now: new Date("2026-10-29T09:00:00Z"), settings: { enabled: false, hour: 8 } })).toBe(false);
    expect(parseDigestSettings({ enabled: "yes", hour: 99 })).toEqual({ enabled: true, hour: 8 });
  });
});

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
  mocks.viewer = S.a as unknown as Record<string, unknown>;
});

const titles = (s: { entries: DigestEntry[] }) => s.entries.map((e) => e.title);

/** Yesterday's events and leftovers for Alice, plus rows in a repository she cannot see. */
async function seedDay() {
  const { db, ids } = S;
  let n = 500;
  const item = (repositoryId: string, o: { type: "ISSUE" | "PULL_REQUEST"; title: string; author: string; state?: "OPEN" | "CLOSED" | "MERGED"; merged?: string; closed?: string; assignees?: string[] }) =>
    db.workItem.create({
      data: {
        repositoryId, githubId: BigInt(900000 + n), number: n++, type: o.type, title: o.title, state: o.state ?? "OPEN", authorLogin: o.author, htmlUrl: "https://example.test/x",
        assignees: o.assignees ?? [], assigneeLogins: indexList(o.assignees ?? []), createdAtGh: at("2026-10-20T08:00:00Z"), updatedAtGh: at("2026-10-28T08:00:00Z"),
        mergedAtGh: o.merged ? at(o.merged) : null, closedAtGh: o.closed ? at(o.closed) : null,
      },
    });
  const merged = await item(ids.repos.api.id, { type: "PULL_REQUEST", title: "MERGED-YESTERDAY", author: "alice-demo", state: "MERGED", merged: "2026-10-28T10:00:00Z" });
  await item(ids.repos.api.id, { type: "PULL_REQUEST", title: "MERGED-AT-WINDOW-START", author: "alice-demo", state: "MERGED", merged: "2026-10-28T00:00:00Z" });
  await item(ids.repos.api.id, { type: "PULL_REQUEST", title: "MERGED-JUST-BEFORE", author: "alice-demo", state: "MERGED", merged: "2026-10-27T23:59:59Z" });
  await item(ids.repos.api.id, { type: "PULL_REQUEST", title: "MERGED-AT-WINDOW-END", author: "alice-demo", state: "MERGED", merged: "2026-10-29T00:00:00Z" });
  await item(ids.repos.api.id, { type: "PULL_REQUEST", title: "MERGED-BY-SOMEONE-ELSE", author: "bram-demo", state: "MERGED", merged: "2026-10-28T10:00:00Z" });
  await item(ids.repos.web.id, { type: "ISSUE", title: "CLOSED-ASSIGNED-TO-ME", author: "bram-demo", state: "CLOSED", closed: "2026-10-28T15:00:00Z", assignees: ["alice-demo"] });
  await item(ids.repos.internal.id, { type: "PULL_REQUEST", title: "HIDDEN-MERGED", author: "alice-demo", state: "MERGED", merged: "2026-10-28T10:00:00Z" });
  await item(ids.repos.internal.id, { type: "ISSUE", title: "HIDDEN-ASSIGNED", author: "owner-demo", assignees: ["alice-demo"] });
  await db.workItem.update({ where: { id: ids.items.web10.id }, data: { assigneeLogins: indexList(["alice-demo"]), assignees: ["alice-demo"] } }); // open issue assigned to Alice

  // A review Alice gave yesterday.
  await db.workItemComment.create({ data: { workItemId: ids.items.web7.id, githubId: 7001n, kind: "REVIEW", authorLogin: "alice-demo", reviewState: "APPROVED", commitSha: "x", body: "ok", createdAtGh: at("2026-10-28T09:00:00Z"), updatedAtGh: at("2026-10-28T09:00:00Z") } });

  // A task finished yesterday, and an overdue one.
  const done = await db.planningColumn.findFirstOrThrow({ where: { projectId: ids.projects.atlas.id, key: "done" } });
  const finished = await db.planningItem.create({ data: { projectId: ids.projects.atlas.id, columnId: done.id, position: 5, title: "TASK-FINISHED", assigneeLogin: "alice-demo", createdById: ids.members.admin.id } });
  await db.planEvent.create({ data: { projectId: ids.projects.atlas.id, itemId: finished.id, kind: "done", toKey: "done", actorLogin: "alice-demo", at: at("2026-10-28T11:00:00Z") } });
  await db.planningItem.update({ where: { id: ids.cards.cDraft.id }, data: { dueDate: new Date("2026-10-27T00:00:00Z"), title: "TASK-OVERDUE" } });

  // An unfinished review draft, a failing sync on a visible repository and a stale unanswered request.
  await db.reviewDraft.create({ data: { userId: ids.users.a.id, workItemId: ids.items.web9.id, path: "a.ts", line: 1, body: "half a thought", commitSha: "c", createdAt: at("2026-10-27T10:00:00Z") } });
  await db.repository.update({ where: { id: ids.repos.web.id }, data: { syncError: "boom" } });
  await db.waitingRecord.create({ data: { workspaceId: ids.ws.id, workItemId: ids.items.api14.id, source: "MANUAL", reviewerKind: "USER", reviewerRef: "maintainer-demo", reason: "Needs the maintainer", startedAt: at("2026-10-26T09:00:00Z") } });

  // Backports recorded as done: one by Alice (but upstream is a repository she cannot see), one by the owner.
  await db.backportRecord.create({ data: { mappingId: ids.map.id, upstreamNumber: 101, targetBranch: "release", state: "done", byLogin: "alice-demo", updatedAt: at("2026-10-28T13:00:00Z") } });
  await db.backportRecord.create({ data: { mappingId: ids.map.id, upstreamNumber: 102, targetBranch: "release", state: "done", byLogin: "owner-demo", updatedAt: at("2026-10-28T13:00:00Z") } });
  return { merged };
}

describe("buildDigest", () => {
  it("fills every section from the person's own data with a fixed clock", async () => {
    await seedDay();
    const d = await buildDigest(S.db, S.a, { now: NOW });
    expect(d.day).toBe(DAY);
    expect(d.window).toEqual({ start: "2026-10-28T00:00:00.000Z", end: "2026-10-29T00:00:00.000Z" });

    // Done: inside [start, end) only, the person's own, reviews and finished tasks included.
    expect(titles(d.done)).toEqual(expect.arrayContaining(["MERGED-YESTERDAY", "MERGED-AT-WINDOW-START", "CLOSED-ASSIGNED-TO-ME", "TASK-FINISHED"]));
    expect(titles(d.done)).toContain(S.ids.items.web7.title); // the review she gave
    for (const t of ["MERGED-JUST-BEFORE", "MERGED-AT-WINDOW-END", "MERGED-BY-SOMEONE-ELSE"]) expect(titles(d.done)).not.toContain(t);
    expect(d.done.entries.find((e) => e.title === "MERGED-YESTERDAY")).toMatchObject({ repo: "northwind/atlas-api", reason: "Your pull request was merged", href: expect.stringMatching(/^\/pull-requests\//) });
    expect(d.done.entries.find((e) => e.title === "TASK-FINISHED")!.href).toMatch(/^\/tasks\//);
    expect(d.done.entries.map((e) => e.since)).toEqual([...d.done.entries.map((e) => e.since)].sort().reverse()); // newest first

    // Undone: open assigned items, her own open pull requests, overdue tasks, unsent review drafts. Oldest first.
    expect(titles(d.undone)).toEqual(expect.arrayContaining([S.ids.items.web10.title, S.ids.items.api14.title, "TASK-OVERDUE", S.ids.items.web9.title]));
    expect(d.undone.entries.find((e) => e.title === "TASK-OVERDUE")).toMatchObject({ reason: "Task was due 2026-10-27", ageDays: 2 });
    expect(d.undone.entries.find((e) => e.title === S.ids.items.web9.title)!.reason).toBe("1 review comment started and not sent");
    const since = d.undone.entries.map((e) => (e.since ? Date.parse(e.since) : Infinity));
    expect(since).toEqual([...since].sort((x, y) => x - y));

    // Attention (mine): review queue, changes requested, failing checks, unread inbox, a failing repository.
    const mine = titles(d.attention.mine);
    expect(mine).toEqual(expect.arrayContaining([S.ids.items.web7.title, S.ids.items.web8.title, S.ids.items.api15.title, "northwind/atlas-web"]));
    expect(d.attention.mine.entries.find((e) => e.key === "inbox")).toMatchObject({ href: "/inbox" });
    expect(d.attention.mine.entries.find((e) => e.key === `checks:${S.ids.items.api15.id}`)!.reason).toMatch(/Checks are failing/);
    expect(d.attention.mine.entries.find((e) => e.title === "northwind/atlas-web")!.reason).toBe("Sync is failing: boom");

    // Attention (others): who it is waiting on.
    const waiting = d.attention.others.entries.find((e) => e.who === "maintainer-demo");
    expect(waiting).toMatchObject({ title: S.ids.items.api14.title, reason: "Waiting on maintainer-demo: Needs the maintainer" });
    expect(d.attention.others.entries.find((e) => e.key === `wait:${S.ids.items.api15.id}:owner-demo`)!.reason).toBe("owner-demo has not reviewed for 2 days");
    expect(d.attention.others.entries.some((e) => e.who === "bram-demo")).toBe(false); // bram answered with a review

    expect(d.counts).toEqual({ done: d.done.total, undone: d.undone.total, mine: d.attention.mine.total, others: d.attention.others.total });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d); // plain JSON: it is stored as is
  });

  it("never shows anything from a repository the person cannot see", async () => {
    await seedDay();
    const d = await buildDigest(S.db, S.a, { now: NOW });
    expect(JSON.stringify(d)).not.toContain("HIDDEN");
    expect(JSON.stringify(d)).not.toContain("internal-tools");
    expect(JSON.stringify(d)).not.toContain("legacy-disconnected"); // a disconnected repository she has no grant on
    expect(titles(d.done)).not.toContain("Upstream #101 brought to release"); // a mapping needs BOTH sides visible
    // The administrator sees all repositories, so the same rows appear for them.
    const admin = await buildDigest(S.db, { ...S.admin, login: "alice-demo", githubLogin: "alice-demo" }, { now: NOW });
    expect(titles(admin.done)).toContain("HIDDEN-MERGED");
    expect(JSON.stringify(admin)).toContain("legacy-disconnected");
    const owner = await buildDigest(S.db, S.admin, { now: NOW });
    expect(titles(owner.done)).toContain("Upstream #102 brought to release");
  });

  it("caps a section and says how many more there are", async () => {
    await seedDay();
    const d = await buildDigest(S.db, S.a, { now: NOW, cap: 2 });
    expect(d.done.entries).toHaveLength(2);
    expect(d.done.more).toBe(d.done.total - 2);
    expect(d.done.total).toBeGreaterThan(2);
    expect((await buildDigest(S.db, S.a, { now: NOW })).done.more).toBe(0);
  });

  it("takes entries from other modules through the source hook, and survives one that fails", async () => {
    const extra: DigestEntry = { key: "upstream:1", title: "Upstream update ran", repo: "acme-labs/dashboard-core", href: "/forks", reason: "Fast-forwarded main", since: "2026-10-28T06:00:00.000Z", ageDays: 1 };
    const seen: string[] = [];
    const d = await buildDigest(S.db, S.a, {
      now: NOW,
      sources: [
        async (ctx) => (seen.push(`${ctx.day} ${ctx.viewer.login} ${ctx.start.toISOString()}`), { done: [extra], mine: [{ ...extra, key: "upstream:2", title: "Upstream update needs you" }] }),
        async () => {
          throw new Error("broken contributor");
        },
      ],
    });
    expect(titles(d.done)).toContain("Upstream update ran");
    expect(titles(d.attention.mine)).toContain("Upstream update needs you");
    expect(seen).toEqual(["2026-10-28 alice-demo 2026-10-28T00:00:00.000Z"]);
    expect(d.counts.done).toBe(d.done.total);

    const off = registerDigestSource("fake", async () => ({ others: [{ ...extra, key: "upstream:3", title: "Upstream failed", who: "maintainer" }] }));
    expect(titles((await buildDigest(S.db, S.a, { now: NOW })).attention.others)).toContain("Upstream failed");
    off();
    expect(titles((await buildDigest(S.db, S.a, { now: NOW })).attention.others)).not.toContain("Upstream failed");
  });
});

describe("stored digests", () => {
  const notes = () => S.db.notification.findMany({ where: { userId: S.ids.users.a.id, kind: "daily-digest" } });

  it("generates once per day, and one notification with it; regenerating changes neither", async () => {
    const first = await generateDigest(S.db, S.a, { now: NOW });
    expect(first.created).toBe(true);
    expect(first.digest.day).toBe(DAY);
    const again = await generateDigest(S.db, S.a, { now: new Date("2026-10-29T15:00:00Z") });
    expect(again.created).toBe(false);
    expect(again.digest.id).toBe(first.digest.id);
    expect(again.digest.generatedAt.getTime()).toBe(NOW.getTime());
    const ns = await notes();
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ href: `/digest?day=${DAY}`, repositoryId: null });
    expect(ns[0].title).toContain(`Digest for ${DAY}`);

    await markDigestRead(S.db, S.a, DAY, NOW);
    const read = await generateDigest(S.db, S.a, { now: new Date("2026-10-29T16:00:00Z"), replace: true });
    expect(read.created).toBe(false);
    expect(read.digest.generatedAt.toISOString()).toBe("2026-10-29T16:00:00.000Z");
    expect(read.digest.readAt).toBeNull(); // new content, unread again
    expect(await S.db.dailyDigest.count({ where: { userId: S.a.userId } })).toBe(1);
    expect(await notes()).toHaveLength(1);
  });

  it("two simultaneous attempts store one digest and one notification", async () => {
    const r = await Promise.all([generateDigest(S.db, S.a, { now: NOW }), generateDigest(S.db, S.a, { now: NOW })]);
    expect(r.filter((x) => x.created)).toHaveLength(1);
    expect(await S.db.dailyDigest.count({ where: { userId: S.a.userId } })).toBe(1);
    expect(await notes()).toHaveLength(1);
  });

  it("makes no notification when that kind is switched off in the preferences", async () => {
    const p = await getPrefs(S.db, S.a.userId);
    await setPrefs(S.db, S.a.userId, { ...p, kinds: { ...p.kinds, "daily-digest": { inApp: false, desktop: false } } });
    expect((await generateDigest(S.db, S.a, { now: NOW })).created).toBe(true);
    expect(await notes()).toHaveLength(0);
  });

  it("is personal: another person's digest is a different row", async () => {
    await generateDigest(S.db, S.a, { now: NOW });
    expect(await getDigest(S.db, S.b, DAY)).toBeNull();
    expect(await listDigestDays(S.db, S.b)).toEqual([]);
    expect(await unreadDigestCount(S.db, S.a)).toBe(1);
    await markDigestRead(S.db, S.a, DAY);
    expect(await unreadDigestCount(S.db, S.a)).toBe(0);
    expect((await notes())[0].readAt).not.toBeNull();
  });

  it("demo mode makes the first digest on demand from the demo data", async () => {
    expect(await listDigestDays(S.db, S.a)).toEqual([]);
    const d = await latestDigest(S.db, S.a, NOW);
    expect(d?.day).toBe(DAY);
    expect(d!.payload.counts.undone).toBeGreaterThan(0);
    expect(d!.payload.counts.mine).toBeGreaterThan(0);
    expect(JSON.stringify(d!.payload)).not.toContain("HIDDEN");
  });
});

describe("the daily check (scheduler)", () => {
  beforeEach(async () => {
    await S.db.user.update({ where: { id: S.a.userId }, data: { isDemo: false } }); // the scheduler serves the one real profile
    await S.db.user.updateMany({ where: { id: { not: S.a.userId } }, data: { isDemo: true } });
  });
  const days = () => S.db.dailyDigest.findMany({ where: { userId: S.a.userId }, select: { day: true } });
  const notes = () => S.db.notification.count({ where: { kind: "daily-digest" } });

  it("waits for the hour, generates once, and stays quiet for the rest of the day", async () => {
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-29T07:59:00Z"))).toBe("not-yet");
    expect(await days()).toEqual([]);
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-29T08:00:00Z"))).toBe("generated");
    for (const t of ["2026-10-29T08:10:00Z", "2026-10-29T12:00:00Z", "2026-10-29T23:50:00Z"]) expect(await runDailyDigest(S.db, S.a.workspaceId, new Date(t))).toBe("have-it");
    expect(await days()).toEqual([{ day: DAY }]);
    expect(await notes()).toBe(1);
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-30T09:00:00Z"))).toBe("generated"); // the next local day
    expect((await days()).map((d) => d.day).sort()).toEqual([DAY, "2026-10-29"]);
  });

  it("catches up on the first check after the app was closed at the configured hour", async () => {
    // Closed from the evening before until 17:30: the first check of the day is already past 08:00.
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-29T17:30:00Z"))).toBe("generated");
    expect((await days()).map((d) => d.day)).toEqual([DAY]);
    // A configured hour of 20 has not passed at 17:30 on the next day yet.
    const p = await getPrefs(S.db, S.a.userId);
    await setPrefs(S.db, S.a.userId, { ...p, digest: { enabled: true, hour: 20 } });
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-30T17:30:00Z"))).toBe("not-yet");
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-30T20:00:00Z"))).toBe("generated");
  });

  it("does nothing when switched off, and without a profile", async () => {
    const p = await getPrefs(S.db, S.a.userId);
    await setPrefs(S.db, S.a.userId, { ...p, digest: { enabled: false, hour: 8 } });
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-29T12:00:00Z"))).toBe("disabled");
    expect(await days()).toEqual([]);
    await S.db.user.updateMany({ data: { isDemo: true } });
    expect(await runDailyDigest(S.db, S.a.workspaceId, new Date("2026-10-29T12:00:00Z"))).toBe("no-profile");
  });

  it("runs as the job type digest.daily and survives running again", async () => {
    expect(typeof handlers["digest.daily"]).toBe("function");
    await enqueue(S.db, { type: "digest.daily", payload: {}, dedupeKey: "digest-test" });
    expect(await runOne(S.db, handlers)).toBe("done");
    expect(await S.db.job.findUnique({ where: { dedupeKey: "digest-test" } })).toMatchObject({ status: "DONE", lastError: null });
  });
});

describe("digest page and settings", () => {
  it("renders the four sections and moves between stored days", async () => {
    await seedDay();
    await generateDigest(S.db, S.a, { now: NOW });
    await generateDigest(S.db, S.a, { now: new Date("2026-10-30T09:00:00Z") });
    const { default: DigestPage } = await import("@/app/(app)/digest/page");
    const html = renderToStaticMarkup(await DigestPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Digest for Oct 29, 2026"); // newest by default
    for (const s of ["Done (", "Left undone (", "Needs you (", "Waiting on others ("]) expect(html).toContain(s);
    expect(html).toContain("/digest?day=2026-10-28"); // older
    expect(html).toContain("Regenerate");
    const older = renderToStaticMarkup(await DigestPage({ searchParams: Promise.resolve({ day: DAY }) }));
    expect(older).toContain("Digest for Oct 28, 2026");
    expect(older).toContain("MERGED-YESTERDAY");
    expect(older).toContain("/digest?day=2026-10-29"); // newer
    expect(older).not.toContain("HIDDEN");
    // An unknown or malformed day falls back to the newest instead of failing.
    expect(renderToStaticMarkup(await DigestPage({ searchParams: Promise.resolve({ day: "<script>" }) }))).toContain("Digest for Oct 29, 2026");
  });

  it("explains itself when there is no digest and the digest is off (a real profile)", async () => {
    await S.db.user.update({ where: { id: S.a.userId }, data: { isDemo: false } });
    vi.stubEnv("DEMO_MODE", "false");
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    try {
      const { default: DigestPage } = await import("@/app/(app)/digest/page");
      expect(renderToStaticMarkup(await DigestPage({ searchParams: Promise.resolve({}) }))).toContain("after 08:00");
      const p = await getPrefs(S.db, S.a.userId);
      await setPrefs(S.db, S.a.userId, { ...p, digest: { enabled: false, hour: 8 } });
      expect(renderToStaticMarkup(await DigestPage({ searchParams: Promise.resolve({}) }))).toContain("turned off");
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });

  it("saves the switch and the hour, and refuses a bad hour", async () => {
    const { saveDigestSettingsAction, regenerateDigestAction, markDigestReadAction } = await import("@/app/digest-actions");
    const fd = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.append(k, v);
      return f;
    };
    expect(await saveDigestSettingsAction(fd({ hour: "24" }))).toMatchObject({ ok: false });
    expect(await saveDigestSettingsAction(fd({ hour: "7.5" }))).toMatchObject({ ok: false });
    expect(await saveDigestSettingsAction(fd({ enabled: "on", hour: "6" }))).toMatchObject({ ok: true });
    expect((await getPrefs(S.db, S.a.userId)).digest).toEqual({ enabled: true, hour: 6 });
    expect(await saveDigestSettingsAction(fd({ hour: "9" }))).toMatchObject({ ok: true });
    expect((await getPrefs(S.db, S.a.userId)).digest).toEqual({ enabled: false, hour: 9 });
    // The other preferences are kept.
    expect((await getPrefs(S.db, S.a.userId)).kinds["review-requested"]).toEqual({ inApp: true, desktop: false });
    expect(await regenerateDigestAction("not a day")).toMatchObject({ ok: false });
    expect(await regenerateDigestAction(DAY)).toMatchObject({ ok: true });
    expect(await markDigestReadAction(DAY)).toMatchObject({ ok: true });
    expect((await getDigest(S.db, S.a, DAY))?.readAt).not.toBeNull();
  });
});
