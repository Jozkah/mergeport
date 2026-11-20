import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTROL_HEADER, FRESH_LINK_TTL_MS, controlFile, controlSecretOk, mintFreshLink, removeControlFile, takeFreshLink, writeControlFile } from "@/lib/local/fresh-link";
import { toastScript, toastXml } from "@/lib/local/toast";
import { dispatchToasts, type ToastOut } from "@/lib/services/toasts";
import { setPrefs } from "@/lib/services/notification-prefs";
import { GET as linkRoute } from "@/app/api/local/link/route";
import { freshSeed } from "./helpers";

describe("fresh sign-in links for the shortcut", () => {
  it("a minted link works once, and only while it is young", () => {
    const s = new Map<string, number>();
    const t = mintFreshLink(1_000, s);
    expect(takeFreshLink("nope", 1_001, s)).toBe(false);
    expect(takeFreshLink(t, 1_001, s)).toBe(true);
    expect(takeFreshLink(t, 1_002, s)).toBe(false); // used
    const old = mintFreshLink(5_000, s);
    expect(takeFreshLink(old, 5_000 + FRESH_LINK_TTL_MS + 1, s)).toBe(false); // expired
  });

  it("only a few links are outstanding at once; the oldest is dropped", () => {
    const s = new Map<string, number>();
    const tokens = Array.from({ length: 7 }, (_, i) => mintFreshLink(1_000 + i, s));
    expect(s.size).toBe(5);
    expect(takeFreshLink(tokens[0], 2_000, s)).toBe(false);
    expect(takeFreshLink(tokens[6], 2_000, s)).toBe(true);
  });

  it("the control secret must match exactly", () => {
    expect(controlSecretOk("abc", "abc")).toBe(true);
    expect(controlSecretOk("abd", "abc")).toBe(false);
    expect(controlSecretOk(null, "abc")).toBe(false);
    expect(controlSecretOk("abc", undefined)).toBe(false);
    expect(controlSecretOk("", "")).toBe(false);
  });

  it("the endpoint refuses browsers and wrong secrets, and hands a link to the right caller", async () => {
    process.env.MERGEPORT_CONTROL_SECRET = "s3cret";
    const call = (headers: Record<string, string>) => linkRoute(new Request("http://127.0.0.1:3000/api/local/link", { headers }));
    expect((await call({})).status).toBe(403);
    expect((await call({ [CONTROL_HEADER]: "wrong" })).status).toBe(403);
    expect((await call({ [CONTROL_HEADER]: "s3cret", origin: "https://evil.example" })).status).toBe(403); // a web page, even with the secret
    const ok = await call({ [CONTROL_HEADER]: "s3cret" });
    expect(ok.status).toBe(200);
    const { url } = (await ok.json()) as { url: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/local\/launch\?token=[\w-]{20,}$/);
    expect(takeFreshLink(new URL(url).searchParams.get("token")!)).toBe(true);
    delete process.env.MERGEPORT_CONTROL_SECRET;
  });

  it("the control file is written for this process only and removed only by it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-control-"));
    let restricted = "";
    writeControlFile(home, { port: 3000, secret: "x", pid: 111, stamp: "abc def" }, (f) => (restricted = f));
    expect(restricted).toBe(controlFile(home));
    expect(JSON.parse(fs.readFileSync(controlFile(home), "utf8"))).toMatchObject({ port: 3000, pid: 111 });
    removeControlFile(home, 222); // another launcher's exit must not delete it
    expect(fs.existsSync(controlFile(home))).toBe(true);
    removeControlFile(home, 111);
    expect(fs.existsSync(controlFile(home))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

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
