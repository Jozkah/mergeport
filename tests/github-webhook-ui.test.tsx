// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/app/github-actions", () => ({
  disconnectGithubInstallationAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  checkGithubInstallationAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  startGithubConnectAction: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
}));

import { GithubSettingsBody, liveUpdatesText, type GithubView, type InstallationRow } from "@/components/settings/GithubPanels";

afterEach(cleanup);

const NOW = new Date("2026-11-21T12:00:00Z");
const row = (o: Partial<InstallationRow> = {}): InstallationRow => ({ installationId: "4242", accountLogin: "acme", accountType: "ORGANIZATION", repositorySelection: "SELECTED", status: "active", connectedAt: new Date("2026-11-20T10:00:00Z"), ...o });
const view = (o: Partial<GithubView> = {}): GithubView => ({ configured: true, manage: true, installations: [row()], ...o });
const live = (v: GithubView) => render(<GithubSettingsBody view={v} result={null} now={NOW} />).container.querySelector("#gh-live")?.textContent ?? null;

describe("Settings > GitHub: Live updates", () => {
  it("shows when the last event arrived", () => {
    expect(live(view({ installations: [row({ lastWebhookAt: new Date("2026-11-21T11:55:00Z") })] }))).toBe("Live updates: On (last event 5m ago)");
  });

  it("uses the newest event across the workspace's accounts", () => {
    const text = liveUpdatesText(true, [row({ lastWebhookAt: new Date("2026-11-21T09:00:00Z") }), row({ installationId: "7", lastWebhookAt: new Date("2026-11-21T11:00:00Z") }), row({ installationId: "8", lastWebhookAt: null })], NOW);
    expect(text).toBe("On (last event 1h ago)");
  });

  it("waits for the first event when the server is set up and none arrived", () => {
    expect(live(view())).toBe("Live updates: Waiting for the first event from GitHub");
  });

  it("falls back to the polling sentence otherwise, in plain words", () => {
    const text = live(view({ configured: false }));
    expect(text).toBe("Live updates: Updates arrive about every 15 minutes");
    expect(text).not.toMatch(/webhook|HMAC|payload|secret/i);
  });
});
