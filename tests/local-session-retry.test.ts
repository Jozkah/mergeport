import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ gh: vi.fn(), cookieSet: vi.fn(), ensure: vi.fn(), create: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: m.cookieSet }) }));
vi.mock("@/lib/local/identity", () => ({ currentGhStatus: m.gh }));
vi.mock("@/lib/local/profile", async (orig) => ({ ...(await orig<typeof import("@/lib/local/profile")>()), ensureLocalProfile: m.ensure }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), createSession: m.create }));

import { startLocalSession } from "@/lib/local/session-routes";

const ok = { state: "ok", identity: { id: 1n, login: "me", name: null, avatarUrl: null, host: "github.com" } };
const flaky = { state: "error", message: "gh: unexpected EOF" };

describe("startLocalSession retries a one-off gh failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(m)) f.mockReset();
    m.ensure.mockResolvedValue({ user: { id: "u1" } });
    m.create.mockResolvedValue({ token: "t", expiresAt: new Date("2030-01-01") });
  });

  it("signs in when the first `gh api user` fails and the retry succeeds", async () => {
    m.gh.mockResolvedValueOnce(flaky).mockResolvedValueOnce(ok);
    const p = startLocalSession();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ ok: true });
    expect(m.gh).toHaveBeenCalledTimes(2);
    expect(m.cookieSet).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("still reports gh-error when the retry fails too, and tries only once more", async () => {
    m.gh.mockResolvedValue(flaky);
    const p = startLocalSession();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ ok: false, error: "gh-error" });
    expect(m.gh).toHaveBeenCalledTimes(2);
    expect(m.cookieSet).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not retry when gh says it is not logged in", async () => {
    m.gh.mockResolvedValue({ state: "not-logged-in" });
    expect(await startLocalSession()).toEqual({ ok: false, error: "gh-login" });
    expect(m.gh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
