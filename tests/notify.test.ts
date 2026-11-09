import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import type { RemoteWorkItem } from "@/lib/github/port";
import { syncRepository } from "@/lib/sync/repository";
import { truncateAll } from "@/lib/demo/seed";
import { DEFAULT_PREFS, isQuiet, parsePrefs, wantsDesktop, wantsInApp } from "@/lib/domain/notify-prefs";
import { desktopCandidates, getPrefs, setPrefs } from "@/lib/services/notification-prefs";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { testDb } from "./helpers";

describe("notification preferences (pure)", () => {
  it("falls back to defaults field by field and drops junk", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    const p = parsePrefs({ kinds: { "review-requested": { inApp: false, desktop: "yes" }, evil: { inApp: false } }, quiet: { enabled: true, start: "25:99", end: "06:30" } });
    expect(p.kinds["review-requested"]).toEqual({ inApp: false, desktop: false });
    expect(p.quiet).toEqual({ enabled: true, start: "22:00", end: "06:30" });
    expect(Object.keys(p.kinds)).toEqual(["review-requested", "changes-requested"]);
  });

  it("quiet hours wrap midnight and follow the person's time zone", () => {
    const p = parsePrefs({ quiet: { enabled: true, start: "22:00", end: "07:00" } });
    expect(isQuiet(p, new Date("2026-10-29T23:30:00Z"), "UTC")).toBe(true);
    expect(isQuiet(p, new Date("2026-10-29T06:59:00Z"), "UTC")).toBe(true);
    expect(isQuiet(p, new Date("2026-10-29T07:00:00Z"), "UTC")).toBe(false);
    expect(isQuiet(p, new Date("2026-10-29T12:00:00Z"), "UTC")).toBe(false);
    // 23:30 UTC is 08:30 the next day in Tokyo: not quiet there.
    expect(isQuiet(p, new Date("2026-10-29T23:30:00Z"), "Asia/Tokyo")).toBe(false);
    expect(isQuiet({ ...p, quiet: { ...p.quiet, enabled: false } }, new Date("2026-10-29T23:30:00Z"), "UTC")).toBe(false);
    expect(isQuiet({ ...p, quiet: { enabled: true, start: "08:00", end: "08:00" } }, new Date("2026-10-29T08:00:00Z"), "UTC")).toBe(false);
  });

  it("desktop is opt-in and held back during quiet hours; in-app defaults on", () => {
    const night = new Date("2026-10-29T23:30:00Z");
    expect(wantsDesktop(DEFAULT_PREFS, "review-requested", night, "UTC")).toBe(false);
    const on = parsePrefs({ kinds: { "review-requested": { inApp: true, desktop: true } }, quiet: { enabled: true, start: "22:00", end: "07:00" } });
    expect(wantsDesktop(on, "review-requested", night, "UTC")).toBe(false);
    expect(wantsDesktop(on, "review-requested", new Date("2026-10-29T12:00:00Z"), "UTC")).toBe(true);
    expect(wantsInApp(DEFAULT_PREFS, "review-requested")).toBe(true);
    expect(wantsInApp(parsePrefs({ kinds: { "review-requested": { inApp: false } } }), "review-requested")).toBe(false);
  });
});

describe("notifications follow the preferences", () => {
  const db = testDb();
  const meta: RepoMeta = { githubId: 1n, fullName: "acme/tool", name: "tool", htmlUrl: "https://github.com/acme/tool", visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 1001n, login: "acme", type: "ORGANIZATION" } };
  const T = (d: number) => new Date(Date.UTC(2026, 9, d));
  const pr = (o: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({
    githubId: 503n, number: 3, type: "PULL_REQUEST", title: "Fix it", body: null, state: "OPEN", draft: false, authorLogin: "author-demo", authorGithubId: 1n, authorAvatar: null, labels: [], assignees: [], milestoneNumber: null, milestoneTitle: null,
    htmlUrl: "https://x/3", createdAt: T(1), updatedAt: T(2), closedAt: null, mergedAt: null, headSha: "h1", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", ...o,
  });
  let fake: FakeGithub;
  let repoId: string;
  let reviewerId: string;
  let authorId: string;

  beforeEach(async () => {
    await truncateAll(db);
    fake = new FakeGithub();
    const ws = await db.workspace.create({ data: { name: "ws" } });
    fake.repos.set("acme/tool", meta);
    repoId = (await upsertRepository(db, ws.id, meta)).id;
    fake.branches.set("acme/tool", [{ name: "main", sha: "m1", isDefault: true }]);
    const mk = async (login: string, id: bigint) => {
      const u = await db.user.create({ data: { githubId: id, login } });
      await db.member.create({ data: { workspaceId: ws.id, userId: u.id, role: "MEMBER" } });
      return u.id;
    };
    reviewerId = await mk("reviewer-demo", 11n);
    authorId = await mk("author-demo", 12n);
    fake.items.set("acme/tool", [pr()]);
  });

  it("creates a review-request notification by default, and none once that kind is turned off", async () => {
    fake.requested.set("acme/tool#3", { users: ["reviewer-demo"], teams: [] });
    await syncRepository(db, fake, repoId, { now: T(10), full: true });
    expect(await db.notification.count({ where: { userId: reviewerId, kind: "review-requested" } })).toBe(1);
    await db.notification.deleteMany();
    await db.reviewRequest.deleteMany();
    await setPrefs(db, reviewerId, { kinds: { "review-requested": { inApp: false, desktop: false } } });
    await syncRepository(db, fake, repoId, { now: T(11), full: true });
    expect(await db.notification.count({ where: { userId: reviewerId } })).toBe(0);
  });

  it("tells the author once when a reviewer asks for changes, never for their own review", async () => {
    fake.reviews.set("acme/tool#3", [{ githubId: 90n, login: "reviewer-demo", state: "CHANGES_REQUESTED", body: null, commitSha: "h1", submittedAt: T(3) }]);
    await syncRepository(db, fake, repoId, { now: T(10), full: true });
    await syncRepository(db, fake, repoId, { now: T(11), full: true });
    const notes = await db.notification.findMany({ where: { userId: authorId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "changes-requested", href: expect.stringMatching(/^\/pull-requests\//) });
    expect(await db.notification.count({ where: { userId: reviewerId } })).toBe(0);
  });

  it("offers a desktop pop-up only for opted-in kinds, outside quiet hours, and only newer than the given time", async () => {
    const { loadViewer } = await import("@/lib/authz/viewer");
    fake.requested.set("acme/tool#3", { users: ["reviewer-demo"], teams: [] });
    await syncRepository(db, fake, repoId, { now: T(10), full: true });
    // A member without a grant on the repository never gets its pop-ups: visibility is applied here as everywhere else.
    expect(await desktopCandidates(db, (await loadViewer(db, reviewerId))!, new Date(0))).toEqual([]);
    await db.member.updateMany({ where: { userId: reviewerId }, data: { role: "ADMIN" } });
    const v = (await loadViewer(db, reviewerId))!;
    const before = new Date(Date.now() - 60_000);
    expect(await desktopCandidates(db, v, before)).toEqual([]); // desktop is off by default
    await setPrefs(db, reviewerId, { kinds: { "review-requested": { inApp: true, desktop: true } } });
    expect((await getPrefs(db, reviewerId)).kinds["review-requested"].desktop).toBe(true);
    expect((await desktopCandidates(db, v, before)).map((n) => n.kind)).toEqual(["review-requested"]);
    expect(await desktopCandidates(db, v, new Date(Date.now() + 60_000))).toEqual([]); // nothing newer
  });
});
