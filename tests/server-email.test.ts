import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, formPost, pathOf, state } from "./auth-mocks";
import { workspaceWithOwner } from "./roles-helpers";
import { sha256 } from "@/lib/crypto";
import { SESSION_COOKIE, createSession, findSession } from "@/lib/auth/session";
import { SETUP_TTL_MS, announceSetupLink, claimSetup, issueSetupToken, setupTokenValid } from "@/lib/auth/setup";
import { MailNotConfiguredError, SmtpMailer, getMailer, invalidateMailerCache, setMailerForTests } from "@/lib/auth/mailer";
import { getSmtpView, loadSmtpConfig, saveSmtpSettings } from "@/lib/services/smtp-settings";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { resetEnvCache } from "@/lib/env";

vi.mock("next/headers", async () => (await import("./auth-mocks")).headersMock);
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

const claimRoute = async () => (await import("@/app/setup/claim/route")).POST;
const KEY = "ab".repeat(32);
const HOUR = 3600_000;

let n = 0;
beforeEach(() => {
  state.db = createTestPrisma(`server-email-${n++}`);
  state.jar.clear();
  setMailerForTests(null);
  vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
  vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
  vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", KEY);
  vi.stubEnv("DEMO_MODE", "false");
  resetEnvCache();
});
afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllEnvs();
  resetEnvCache();
  vi.restoreAllMocks();
});

const db = () => state.db!;
const admin = () => db().user.create({ data: { login: "root", email: "root@example.com", isServerAdmin: true } });
const smtp = { host: "smtp.example.com", port: "587", security: "starttls", username: "mailer", password: "s3cret-pass", mailFrom: "Mergeport <no-reply@example.com>" };

describe("setup link", () => {
  it("prints one line with the link, stores only the hash, and a new start replaces the old link", async () => {
    const lines: string[] = [];
    const t1 = await announceSetupLink(db(), ORIGIN, (l) => lines.push(l));
    expect(lines).toEqual([`Mergeport setup: open ${ORIGIN}/setup/${t1} to create the server administrator.`]);
    const rows = await db().setupToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(t1!));
    expect(JSON.stringify(rows)).not.toContain(t1!);
    const t2 = await issueSetupToken(db());
    expect(await db().setupToken.count()).toBe(1);
    expect(await setupTokenValid(db(), t1)).toBe(false);
    expect(await setupTokenValid(db(), t2)).toBe(true);
  });

  it("works once", async () => {
    const t = (await issueSetupToken(db()))!;
    const r = await claimSetup(db(), { token: t, email: "Boss@Example.com", name: "Boss" });
    expect(r).toMatchObject({ ok: true, created: true });
    const u = await db().user.findUniqueOrThrow({ where: { email: "boss@example.com" } });
    expect(u.isServerAdmin).toBe(true);
    expect(u.emailVerifiedAt).toBeNull(); // the inbox is not proven by the setup link
    expect(await setupTokenValid(db(), t)).toBe(false);
    expect(await claimSetup(db(), { token: t, email: "other@example.com" })).toEqual({ ok: false, reason: "invalid" });
    expect(await db().user.count({ where: { isServerAdmin: true } })).toBe(1);
  });

  it("expires after 24 hours", async () => {
    const t0 = new Date();
    const t = (await issueSetupToken(db(), t0))!;
    const late = new Date(t0.getTime() + SETUP_TTL_MS + 1);
    expect(await setupTokenValid(db(), t, new Date(t0.getTime() + SETUP_TTL_MS - HOUR))).toBe(true);
    expect(await setupTokenValid(db(), t, late)).toBe(false);
    expect(await claimSetup(db(), { token: t, email: "a@example.com" }, late)).toEqual({ ok: false, reason: "invalid" });
    expect(await db().user.count()).toBe(0);
  });

  it("is refused, and none is made, once a server administrator exists", async () => {
    const t = (await issueSetupToken(db()))!;
    await admin();
    expect(await setupTokenValid(db(), t)).toBe(false);
    expect(await claimSetup(db(), { token: t, email: "intruder@example.com" })).toEqual({ ok: false, reason: "invalid" });
    expect(await db().user.findUnique({ where: { email: "intruder@example.com" } })).toBeNull();
    const lines: string[] = [];
    expect(await announceSetupLink(db(), ORIGIN, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([]);
    expect(await db().setupToken.count()).toBe(0);
  });

  it("the route signs the browser in as the new administrator and lands on Settings > Email (or onboarding without a workspace)", async () => {
    const t = (await issueSetupToken(db()))!;
    const res = await (await claimRoute())(formPost("/setup/claim", { token: t, email: "boss@example.com", name: "Boss" }, { "x-forwarded-for": "198.51.100.9" }));
    expect(res.status).toBe(303);
    expect(pathOf(res)).toBe("/onboarding");
    const s = await findSession(db(), state.jar.get(SESSION_COOKIE)?.value);
    const u = await db().user.findUniqueOrThrow({ where: { email: "boss@example.com" } });
    expect(s?.userId).toBe(u.id);
    // A second use of the same link is a 404 and signs nobody in.
    state.jar.clear();
    const again = await (await claimRoute())(formPost("/setup/claim", { token: t, email: "x@example.com" }, { "x-forwarded-for": "198.51.100.9" }));
    expect(again.status).toBe(404);
    expect(state.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("mode=me makes the signed-in person administrator and keeps their session; without a session nothing is used up", async () => {
    const t = (await issueSetupToken(db()))!;
    const signedOut = await (await claimRoute())(formPost("/setup/claim", { token: t, mode: "me" }, { "x-forwarded-for": "198.51.100.11" }));
    expect(pathOf(signedOut)).toBe(`/setup/${t}?error=signed-out`);
    expect(await setupTokenValid(db(), t)).toBe(true);
    const me = await db().user.create({ data: { login: "me", email: "me@example.com" } });
    const s = await createSession(db(), me.id);
    state.jar.set(SESSION_COOKIE, { value: s.token, options: {} });
    const res = await (await claimRoute())(formPost("/setup/claim", { token: t, mode: "me", email: "someone@example.com" }, { "x-forwarded-for": "198.51.100.11" }));
    expect(res.status).toBe(303);
    expect((await db().user.findUniqueOrThrow({ where: { id: me.id } })).isServerAdmin).toBe(true);
    expect(await db().user.findUnique({ where: { email: "someone@example.com" } })).toBeNull();
    expect(state.jar.get(SESSION_COOKIE)?.value).toBe(s.token);
    expect(await setupTokenValid(db(), t)).toBe(false);
  });

  it("the route is rate limited per client address", async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 11; i++) statuses.push(pathOf(await (await claimRoute())(formPost("/setup/claim", { token: "x".repeat(43), email: "nope" }, { "x-forwarded-for": "198.51.100.10" }))));
    expect(statuses.slice(0, 10).every((p) => p.endsWith("error=email-invalid"))).toBe(true);
    expect(statuses[10]).toMatch(/error=rate-limited$/);
  });
});

describe("Settings > Email", () => {
  it("only a server administrator can save, whatever their workspace role", async () => {
    const { owner, viewer } = await workspaceWithOwner(db());
    expect(viewer.isAdmin).toBe(true); // owner of a workspace, still not a server administrator
    await expect(saveSmtpSettings(db(), owner.id, smtp)).rejects.toThrow(ForbiddenError);
    expect(await db().serverSettings.count()).toBe(0);
    const root = await admin();
    await saveSmtpSettings(db(), root.id, smtp);
    expect(await db().serverSettings.count()).toBe(1);
  });

  it("stores the password encrypted, never returns it, and a blank password keeps the saved one", async () => {
    const root = await admin();
    await saveSmtpSettings(db(), root.id, smtp);
    const row = await db().serverSettings.findUniqueOrThrow({ where: { id: "server" } });
    expect(row.smtpPasswordEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("s3cret-pass");
    const view = await getSmtpView(db());
    expect(view).toMatchObject({ host: "smtp.example.com", port: 587, security: "starttls", username: "mailer", hasPassword: true });
    expect(JSON.stringify(view)).not.toContain("s3cret-pass");
    expect(Object.keys(view)).not.toContain("password");
    await saveSmtpSettings(db(), root.id, { ...smtp, password: "" });
    const load = await loadSmtpConfig(db());
    expect(load.kind === "ok" && load.config.password).toBe("s3cret-pass");
    await saveSmtpSettings(db(), root.id, { ...smtp, password: "", clearPassword: true });
    expect((await getSmtpView(db())).hasPassword).toBe(false);
  });

  it("refuses to save a password without MERGEPORT_ENCRYPTION_KEY, and a password saved under another key is not used", async () => {
    const root = await admin();
    await saveSmtpSettings(db(), root.id, smtp);
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    await expect(saveSmtpSettings(db(), root.id, { ...smtp, password: "new" })).rejects.toThrow(ValidationError);
    expect((await getSmtpView(db())).keyConfigured).toBe(false);
    expect((await loadSmtpConfig(db())).kind).toBe("undecryptable");
    invalidateMailerCache();
    await expect(getMailer(db())).rejects.toThrow(MailNotConfiguredError);
  });

  it("rejects header injection in the sender and a host with a scheme", async () => {
    const root = await admin();
    await expect(saveSmtpSettings(db(), root.id, { ...smtp, mailFrom: "a@example.com\r\nBcc: x@evil.test" })).rejects.toThrow(ValidationError);
    await expect(saveSmtpSettings(db(), root.id, { ...smtp, host: "smtp://smtp.example.com" })).rejects.toThrow(ValidationError);
    await expect(saveSmtpSettings(db(), root.id, { ...smtp, security: "ssl3" })).rejects.toThrow(ValidationError);
  });
});

describe("getMailer", () => {
  it("uses the saved settings (STARTTLS on 587 by default) and picks up a save once the cache is invalidated", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(getMailer(db())).rejects.toThrow(MailNotConfiguredError);
    const root = await admin();
    await saveSmtpSettings(db(), root.id, { ...smtp, port: "" });
    // Still cached as "not configured" until the save invalidates it (the action does).
    await expect(getMailer(db())).rejects.toThrow(MailNotConfiguredError);
    invalidateMailerCache();
    const spy = vi.spyOn(nodemailer, "createTransport");
    const m = await getMailer(db());
    expect(m).toBeInstanceOf(SmtpMailer);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true, auth: { user: "mailer", pass: "s3cret-pass" } }));
    await saveSmtpSettings(db(), root.id, { ...smtp, port: "465", security: "tls", username: "" });
    invalidateMailerCache();
    await getMailer(db());
    const opts = spy.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({ port: 465, secure: true });
    expect(opts.auth).toBeUndefined();
  });
});
