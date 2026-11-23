import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toastScript, toastXml } from "@/lib/local/toast";
import { dispatchToasts, type ToastOut } from "@/lib/services/toasts";
import { setPrefs } from "@/lib/services/notification-prefs";
import { freshSeed } from "./helpers";

describe("Windows toast content", () => {
  it("escapes everything and never puts notification text on a command line", () => {
    const t = { title: `Review <b>"now"</b> & 'quick'`, body: "x", url: "http://127.0.0.1:3000/inbox?a=1&b=2" };
    const xml = toastXml(t);
    expect(xml).toContain("&lt;b&gt;&quot;now&quot;&lt;/b&gt; &amp; &apos;quick&apos;");
    expect(xml).toContain('launch="http://127.0.0.1:3000/inbox?a=1&amp;b=2"');
    expect(xml).not.toContain("<b>");
    const script = toastScript(t);
    expect(script).not.toContain("quick"); // the text travels base64-encoded
    expect(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(script)![1], "base64").toString("utf8")).toBe(xml);
  });
});

describe("notifications while no tab is open", () => {
  let S: Awaited<ReturnType<typeof freshSeed>>;
  const shown: ToastOut[] = [];
  const base = "http://127.0.0.1:3000";
  const run = (o: { active?: boolean; now?: Date } = {}) => dispatchToasts(S.db, S.admin.workspaceId, { active: o.active ?? false, show: (t) => shown.push(t), baseUrl: base, now: o.now });
  const note = (title: string, extra: { kind?: string; href?: string | null; createdAt?: Date; readAt?: Date } = {}) =>
    S.db.notification.create({ data: { workspaceId: S.admin.workspaceId, userId: S.admin.userId, kind: extra.kind ?? "review-requested", title, href: extra.href === undefined ? "/pull-requests/x" : extra.href, createdAt: extra.createdAt ?? new Date(), readAt: extra.readAt, toastedAt: null } });

  beforeEach(async () => {
    S = await freshSeed();
    shown.length = 0;
    await S.db.user.update({ where: { id: S.admin.userId }, data: { isDemo: false } });
    await S.db.notification.deleteMany({});
    await setPrefs(S.db, S.admin.userId, { kinds: { "review-requested": { inApp: true, desktop: true }, "changes-requested": { inApp: true, desktop: false }, "daily-digest": { inApp: true, desktop: false } } });
  });
  afterEach(() => void 0);

  it("shows a wanted notification once, links to it, and stamps it", async () => {
    await note("Alice asked you to review #7");
    expect(await run()).toEqual({ shown: 1, stamped: 1 });
    expect(shown).toEqual([{ title: "Alice asked you to review #7", body: "Open it in Mergeport", url: `${base}/pull-requests/x` }]);
    expect(await run()).toEqual({ shown: 0, stamped: 0 }); // decided once
    expect(shown).toHaveLength(1);
  });

  it("stays quiet for kinds that are not wanted, old ones, read ones, and while a tab is open", async () => {
    await note("changes asked", { kind: "changes-requested" });
    await note("ancient", { createdAt: new Date(Date.now() - 48 * 3_600_000) });
    await note("already read", { readAt: new Date() });
    expect(await run()).toMatchObject({ shown: 0, stamped: 2 }); // the read one is not touched
    await note("fresh while a tab is open");
    expect(await run({ active: true })).toMatchObject({ shown: 0, stamped: 1 });
    expect(shown).toHaveLength(0);
  });

  it("holds notifications during quiet hours and shows them when they end", async () => {
    await setPrefs(S.db, S.admin.userId, { kinds: { "review-requested": { inApp: true, desktop: true }, "changes-requested": { inApp: true, desktop: false }, "daily-digest": { inApp: true, desktop: false } }, quiet: { enabled: true, start: "22:00", end: "07:00" } });
    await note("late one", { createdAt: new Date("2026-11-20T23:00:00Z") });
    const night = new Date("2026-11-20T23:30:00Z");
    S.admin.timezone = "UTC";
    expect(await run({ now: night })).toEqual({ shown: 0, stamped: 0 });
    expect(await db_pending()).toBe(1);
    expect(await run({ now: new Date("2026-11-21T07:30:00Z") })).toMatchObject({ shown: 1 });
  });

  it("turns more than three into one summary", async () => {
    for (let i = 1; i <= 5; i++) await note(`item ${i}`);
    expect(await run()).toMatchObject({ shown: 5 });
    expect(shown).toEqual([{ title: "5 new notifications", body: "Open Mergeport to see them", url: `${base}/activity` }]);
  });

  async function db_pending() {
    return S.db.notification.count({ where: { toastedAt: null, readAt: null } });
  }
});
