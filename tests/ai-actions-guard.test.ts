import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "MEMBER" as string,
  saved: { baseUrl: "https://good.example.com/v1", apiKey: "SAVED-SECRET", model: null as string | null } as { baseUrl: string; apiKey: string | null; model: string | null } | null,
  listed: [] as { baseUrl: string; apiKey: string | null }[],
  saves: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: {}, resolveDbFile: () => "x" }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), isDemo: () => false }));
vi.mock("@/lib/hub/session-vault", () => ({ keyFileFor: () => "k", openVault: () => ({}) }));
vi.mock("@/lib/auth/current", () => ({
  requireWriter: async () => {
    if (h.role === "READER") {
      const { ForbiddenError } = await import("@/lib/errors");
      throw new ForbiddenError("Your role is read-only in this workspace");
    }
    return { user: { id: "u" }, viewer: { workspaceId: "w", role: h.role, isAdmin: h.role === "ADMIN" || h.role === "OWNER", memberId: "m", userId: "u" }, csrf: "x" };
  },
}));
vi.mock("@/lib/services/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/services/ai")>()),
  loadAiConfig: async () => h.saved,
  saveAiSettings: async () => void h.saves++,
  listModelInfo: async (cfg: { baseUrl: string; apiKey: string | null }) => {
    h.listed.push({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    return [{ id: "m1", loaded: null }];
  },
}));

import { listAiModelsAction, saveAiSettingsAction } from "@/app/ai-actions";

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  h.role = "MEMBER";
  h.listed = [];
  h.saves = 0;
  h.saved = { baseUrl: "https://good.example.com/v1", apiKey: "SAVED-SECRET", model: null };
});

describe("the workspace AI key", () => {
  it("is never sent to a different address a member types in", async () => {
    const r = await listAiModelsAction(form({ baseUrl: "https://attacker.example.net/v1", apiKey: "" }));
    expect(r).toMatchObject({ ok: true });
    expect(h.listed).toEqual([{ baseUrl: "https://attacker.example.net/v1", apiKey: null }]);
    expect(JSON.stringify(h.listed)).not.toContain("SAVED-SECRET");
  });

  it("an address that only looks alike (path, host or scheme differences) does not get it either", async () => {
    for (const u of ["https://good.example.com/v2", "https://good.example.com.evil.net/v1", "http://127.0.0.1:9/v1"]) await listAiModelsAction(form({ baseUrl: u }));
    expect(h.listed.every((x) => x.apiKey === null)).toBe(true);
  });

  it("is used for the saved address, also when written differently (trailing slash) or left empty", async () => {
    await listAiModelsAction(form({ baseUrl: "https://good.example.com/v1/" }));
    await listAiModelsAction(form({ baseUrl: "" }));
    expect(h.listed.map((x) => x.apiKey)).toEqual(["SAVED-SECRET", "SAVED-SECRET"]);
  });

  it("a key typed into the form is sent as typed", async () => {
    await listAiModelsAction(form({ baseUrl: "https://other.example.com/v1", apiKey: "mine" }));
    expect(h.listed[0].apiKey).toBe("mine");
  });

  it("a READER cannot list models at all; a MEMBER cannot save the settings, an ADMIN can", async () => {
    h.role = "READER";
    expect((await listAiModelsAction(form({ baseUrl: "https://good.example.com/v1" }))).ok).toBe(false);
    expect(h.listed).toHaveLength(0);
    h.role = "MEMBER";
    const denied = await saveAiSettingsAction(form({ baseUrl: "https://attacker.example.net/v1", apiKey: "x" }));
    expect(denied).toMatchObject({ ok: false, error: "Administrator only" });
    expect(h.saves).toBe(0);
    h.role = "ADMIN";
    expect((await saveAiSettingsAction(form({ baseUrl: "https://good.example.com/v1", apiKey: "x" }))).ok).toBe(true);
    expect(h.saves).toBe(1);
  });
});
