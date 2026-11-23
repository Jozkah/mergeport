// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/app/api-token-actions", () => ({
  createApiTokenAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  revokeApiTokenAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
}));
vi.mock("@/app/oauth-actions", () => ({ revokeOAuthGrantAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })), decideOAuthAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })) }));

import { ConnectAiBody, type ConnectAiView } from "@/components/settings/ConnectAiPanel";
import type { TokenRow } from "@/lib/services/api-tokens";

afterEach(cleanup);
Object.defineProperty(window, "matchMedia", { writable: true, value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });

const NOW = new Date("2026-11-22T12:00:00Z");
const tok = (o: Partial<TokenRow> = {}): TokenRow => ({ id: "t1", name: "Claude laptop", prefix: "mp_pat_AbCdE", scope: "WRITE", createdAt: new Date("2026-11-20T10:00:00Z"), lastUsedAt: new Date("2026-11-22T11:00:00Z"), expiresAt: new Date("2027-02-20T00:00:00Z"), revokedAt: null, owner: "me@example.com", mine: true, state: "active", ...o });
const view = (o: Partial<ConnectAiView> = {}): ConnectAiView => ({ connectorUrl: "https://mp.example.com/api/mcp", canWrite: true, admin: false, tokens: [tok()], apps: [], ...o });
const show = (v: ConnectAiView) => render(<ConnectAiBody view={v} now={NOW} />).container;

describe("Settings > Connect AI (MCP)", () => {
  it("shows the connector address and the setup text, with the token as a placeholder", () => {
    const c = show(view());
    expect((c.querySelector('input[readonly]') as HTMLInputElement).value).toBe("https://mp.example.com/api/mcp");
    expect(c.textContent).toContain('claude mcp add --transport http mergeport https://mp.example.com/api/mcp --header "Authorization: Bearer <your token>"');
    expect(c.textContent).toMatch(/cannot edit, move or delete anything, and it never changes GitHub/);
  });

  it("lists a token with its fingerprint, scope, last use and expiry, and never a secret", () => {
    const c = show(view());
    const row = c.querySelector('[data-token="t1"]')!;
    expect(row.textContent).toContain("Claude laptop");
    expect(row.textContent).toContain("mp_pat_AbCdE…");
    expect(row.textContent).toContain("Read and write");
    expect(row.textContent).toContain("used 1h ago");
    expect(row.textContent).toContain("expires Feb 20, 2027");
    expect(row.querySelector('button[aria-label="Revoke token Claude laptop"]')).toBeTruthy();
    expect(c.textContent).not.toMatch(/mp_pat_[A-Za-z0-9_-]{20,}/);
  });

  it("offers Revoke only on an active token, and says why a dead one is dead", () => {
    const c = show(view({ tokens: [tok({ id: "a" }), tok({ id: "r", name: "Old", state: "revoked", revokedAt: new Date("2026-11-01T00:00:00Z"), lastUsedAt: null }), tok({ id: "e", name: "Stale", state: "expired", expiresAt: new Date("2026-11-10T00:00:00Z") })] }));
    expect(c.querySelector('[data-token="a"] button[aria-label^="Revoke"]')).toBeTruthy();
    expect(c.querySelector('[data-token="r"] button[aria-label^="Revoke"]')).toBeNull();
    expect(c.querySelector('[data-token="e"] button[aria-label^="Revoke"]')).toBeNull();
    expect(c.querySelector('[data-token="r"]')!.textContent).toMatch(/Revoked.*never used.*revoked Nov 1, 2026/);
    expect(c.querySelector('[data-token="e"]')!.textContent).toMatch(/Expired.*expired Nov 10, 2026/);
  });

  it("an administrator sees everyone's tokens, named; a person sees only their own", () => {
    const admin = show(view({ admin: true, tokens: [tok(), tok({ id: "t2", name: "Bram's", mine: false, owner: "bram@example.com" })] }));
    expect(admin.textContent).toContain("Tokens in this workspace");
    expect(admin.querySelector('[data-token="t2"]')!.textContent).toContain("bram@example.com");
    expect(admin.querySelector('[data-token="t1"]')!.textContent).not.toContain("me@example.com");
    cleanup();
    expect(show(view()).textContent).toContain("Your tokens");
  });

  it("explains an empty list and, for a read-only role, that tokens can only read", () => {
    const c = show(view({ tokens: [], canWrite: false }));
    expect(c.textContent).toContain("No tokens yet");
    expect(c.textContent).toContain("Your role is read-only here, so tokens can only read.");
    expect(c.querySelector('input[name="name"]')).toBeTruthy();
    expect(c.querySelector('input[name="scope"]')).toBeTruthy();
    expect(c.querySelector('input[name="expires"]')).toBeTruthy();
  });
});
