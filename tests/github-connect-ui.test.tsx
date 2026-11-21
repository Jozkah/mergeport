// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";
import { RESULT_MESSAGES, CONNECT_RESULTS } from "@/lib/github/connect-messages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page components import the server actions; here they are plain spies (the actions themselves are tested in github-connect.test.ts).
const m = vi.hoisted(() => ({
  disconnect: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  check: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
  start: vi.fn(async (): Promise<ActionResult> => ({ ok: true, data: { redirect: "https://github.com/apps/x/installations/new?state=s" } })),
}));
vi.mock("@/app/github-actions", () => ({ disconnectGithubInstallationAction: m.disconnect, checkGithubInstallationAction: m.check, startGithubConnectAction: m.start }));

import { GithubSettingsBody, OPERATOR_SETTINGS, type GithubView, type InstallationRow } from "@/components/settings/GithubPanels";
import { GithubConnectionBanner } from "@/components/shell/GithubConnectionBanner";

beforeAll(() => {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p.hasPointerCapture ??= () => false;
  p.setPointerCapture ??= () => {};
  p.releasePointerCapture ??= () => {};
  p.scrollIntoView ??= () => {};
  (globalThis as Record<string, unknown>).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (o: Partial<InstallationRow> = {}): InstallationRow => ({ installationId: "4242", accountLogin: "acme", accountType: "ORGANIZATION", repositorySelection: "SELECTED", status: "active", connectedAt: new Date("2026-11-20T10:00:00Z"), ...o });
const view = (o: Partial<GithubView> = {}): GithubView => ({ configured: true, manage: true, installations: [], ...o });
/** The submit button of a form by its label (a collapsible panel head can carry the same words, so a plain role query is ambiguous). */
const submitButton = (name: string) => screen.getAllByRole("button", { name }).find((b) => b.getAttribute("type") === "submit")!;
/** Text of every alert on the page (every ActionForm keeps an empty one). */
const alerts = () => screen.getAllByRole("alert").map((a) => a.textContent ?? "").join(" | ");
const page = (v: GithubView, result = null as Parameters<typeof GithubSettingsBody>[0]["result"]) => render(<GithubSettingsBody view={v} result={result} />);

/** Words a hosted workspace must never show (the local app's vocabulary and development-phase talk). */
const FORBIDDEN = /this computer|GitHub CLI|\bgh\b|later task|coming soon|not implemented|placeholder|\bphase\b|TODO/i;

describe("Settings > GitHub: page states", () => {
  it("not set up on the server: an administrator is told what is missing in plain words; a normal person is told to contact their administrator", () => {
    const admin = page(view({ configured: false, manage: true }));
    expect(screen.getByText("GitHub is not set up on this server")).toBeTruthy();
    expect(screen.getByText(/Ask whoever runs this server/)).toBeTruthy();
    for (const s of OPERATOR_SETTINGS) expect(admin.container.textContent).toContain(s.name);
    expect(admin.container.querySelector("form")).toBeNull(); // nothing to press until the server is set up
    cleanup();

    const reader = page(view({ configured: false, manage: false }));
    expect(screen.getByText(/Contact your administrator/)).toBeTruthy();
    expect(reader.container.textContent).not.toContain("MERGEPORT_GITHUB_APP");
  });

  it("configured but nothing connected: an administrator gets 'Connect GitHub' as the primary action and 'Use an existing installation'", () => {
    const { container } = page(view());
    expect(submitButton("Connect GitHub").className).toMatch(/btn-primary/);
    expect(submitButton("Use an existing installation")).toBeTruthy();
    expect(screen.getByLabelText(/GitHub account/)).toBeTruthy();
    expect(container.textContent).toMatch(/GitHub is not connected yet/);
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("a member or reader sees a read-only status and no way to connect", () => {
    const { container } = page(view({ manage: false }));
    expect(screen.getByText("GitHub is not connected")).toBeTruthy();
    expect(screen.getByText(/Ask the owner or an administrator to connect it/)).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("connected: lists each account with neutral type and selection chips and an icon-bearing status", () => {
    const { container } = page(view({ installations: [row(), row({ installationId: "7", accountLogin: "octo", accountType: "USER", repositorySelection: "ALL" })] }));
    expect(container.textContent).toContain("Organization");
    expect(container.textContent).toContain("Personal account");
    expect(container.textContent).toContain("Selected repositories");
    expect(container.textContent).toContain("All repositories");
    const status = screen.getAllByText("Active");
    expect(status).toHaveLength(2);
    for (const s of status) {
      expect(s.className).toMatch(/pill-ok/);
      expect(s.querySelector("svg")).not.toBeNull(); // colour never stands alone
    }
    for (const chip of [...container.querySelectorAll(".pill-neutral")]) expect(chip.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain("Nov 20, 2026");
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("suspended and removed show their own status and a 'Check again' button (never for an active one)", () => {
    const { container } = page(view({ installations: [row({ installationId: "1", accountLogin: "sus", status: "suspended" }), row({ installationId: "2", accountLogin: "gone", status: "removed" }), row({ installationId: "3", accountLogin: "fine" })] }));
    const sus = screen.getByText("Suspended on GitHub");
    expect(sus.className).toMatch(/pill-waiting/);
    expect(sus.querySelector("svg")).not.toBeNull();
    const gone = screen.getByText("Removed on GitHub");
    expect(gone.className).toMatch(/pill-blocked/);
    expect(gone.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^Check .* again$/ })).toHaveLength(2);
    expect(container.textContent).toMatch(/unsuspended there/);
    expect(container.textContent).toMatch(/uninstalled on GitHub/);
  });

  it("a read-only viewer sees the connections but no Disconnect, no Check again and no connect form", () => {
    const { container } = page(view({ manage: false, installations: [row({ status: "suspended" })] }));
    expect(screen.getByText("Suspended on GitHub")).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect|Check/ })).toBeNull();
    expect(screen.getByText(/Only the owner and administrators can connect or disconnect GitHub/)).toBeTruthy();
  });

  it("a very long account name is one truncated line with the full text available, and the text never forces horizontal scroll", () => {
    const long = "a-very-long-organization-name-".repeat(1).padEnd(39, "x");
    const { container } = page(view({ installations: [row({ accountLogin: long })] }));
    const name = container.querySelector(`[title="${long}"]`)!;
    expect(name.className).toMatch(/truncate/);
    expect(name.className).toMatch(/max-w-full/);
    expect(name.getAttribute("tabindex")).toBe("0"); // reachable by keyboard like Host
    expect(name.getAttribute("aria-label")).toBe(long);
  });

  it("with several accounts, an administrator still gets 'Connect another account'", () => {
    page(view({ installations: [row()] }));
    expect(screen.getByText("Connect another account")).toBeTruthy();
    expect(submitButton("Connect GitHub")).toBeTruthy();
  });
});

describe("Settings > GitHub: result messages", () => {
  it("every code has a fixed message with a title and a next step, and none holds a token, code or id", () => {
    for (const c of CONNECT_RESULTS) {
      const r = RESULT_MESSAGES[c];
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.body.length).toBeGreaterThan(10);
      expect(`${r.title} ${r.body}`).not.toMatch(FORBIDDEN);
      expect(`${r.title} ${r.body}`).not.toMatch(/ghu_|ghs_|client secret|installation id|\d{5,}/i);
    }
  });

  it("an error is announced as an alert, a success as a status, and the owner refusal carries the exact next step", () => {
    page(view(), RESULT_MESSAGES["not-owner"]);
    expect(alerts()).toMatch(/Could not verify that you are an owner of the organization/);
    expect(alerts()).toMatch(/Ask an owner of the organization to connect it, or install the App yourself/);
    cleanup();
    page(view(), RESULT_MESSAGES.connected);
    expect(screen.getAllByRole("status").map((x) => x.textContent).join(" | ")).toMatch(/GitHub is connected/);
  });
});

describe("Disconnect", () => {
  it("asks first: names the consequence, focuses Cancel, and only the danger button runs the action", async () => {
    page(view({ installations: [row()] }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Disconnect acme" })); });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Disconnect acme?")).toBeTruthy();
    expect(dialog.textContent).toMatch(/nothing is deleted/);
    expect(dialog.textContent).toMatch(/show as not connected/);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel)); // Cancel is focused, not the danger button
    const go = within(dialog).getByRole("button", { name: "Disconnect" });
    expect(go.className).toMatch(/btn-danger/);

    await act(async () => { fireEvent.click(cancel); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.disconnect).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Disconnect acme" })); });
    const again = await screen.findByRole("dialog");
    await act(async () => { fireEvent.submit(within(again).getByRole("button", { name: "Disconnect" }).closest("form")!); });
    await waitFor(() => expect(m.disconnect).toHaveBeenCalledTimes(1));
    const sent = (m.disconnect.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get("installationId")).toBe("4242");
  });

  it("Check again sends the installation id", async () => {
    page(view({ installations: [row({ status: "removed" })] }));
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Check acme again" }).closest("form")!); });
    await waitFor(() => expect(m.check).toHaveBeenCalledTimes(1));
    expect(((m.check.mock.calls[0] as unknown as [FormData])[0]).get("installationId")).toBe("4242");
  });
});

describe("Connect buttons", () => {
  it("'Connect GitHub' starts the install flow and goes to GitHub only for an https address", async () => {
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    try {
      page(view());
      await act(async () => { fireEvent.submit(submitButton("Connect GitHub").closest("form")!); });
      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/apps/x/installations/new?state=s"));
      expect((m.start.mock.calls[0] as unknown as [FormData])[0].get("mode")).toBe("install");

      m.start.mockResolvedValueOnce({ ok: true, data: { redirect: "javascript:alert(1)" } });
      await act(async () => { fireEvent.submit(submitButton("Use an existing installation").closest("form")!); });
      await waitFor(() => expect(alerts()).toMatch(/Nothing was connected/));
      expect(assign).toHaveBeenCalledTimes(1); // the unsafe address was never opened
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });

  it("'Use an existing installation' sends the mode and the optional account name", async () => {
    page(view());
    fireEvent.change(screen.getByLabelText(/GitHub account/), { target: { value: "acme" } });
    await act(async () => { fireEvent.submit(submitButton("Use an existing installation").closest("form")!); });
    await waitFor(() => expect(m.start).toHaveBeenCalledTimes(1));
    const f = (m.start.mock.calls[0] as unknown as [FormData])[0];
    expect(f.get("mode")).toBe("existing");
    expect(f.get("account")).toBe("acme");
  });
});

describe("layout banner variants", () => {
  it("nothing connected: an administrator gets a 'Connect GitHub' link to Settings, everyone else plain text that says who to ask", () => {
    render(<GithubConnectionBanner state="none" manage />);
    const link = screen.getByRole("link", { name: "Connect GitHub" });
    expect(link.getAttribute("href")).toBe("/settings/github");
    expect(screen.getByText("GitHub is not connected yet")).toBeTruthy();
    cleanup();

    const { container } = render(<GithubConnectionBanner state="none" manage={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toMatch(/Ask the owner or an administrator/);
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("suspended and removed say what happened; only an administrator gets the link", () => {
    const sus = render(<GithubConnectionBanner state="suspended" manage />);
    expect(sus.container.textContent).toMatch(/suspended the Mergeport App/);
    expect(screen.getByRole("link", { name: "Open GitHub settings" }).getAttribute("href")).toBe("/settings/github");
    cleanup();
    const gone = render(<GithubConnectionBanner state="removed" manage={false} />);
    expect(gone.container.textContent).toMatch(/uninstalled on GitHub/);
    expect(gone.container.textContent).toMatch(/Ask the owner or an administrator/);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("an active connection shows no banner", () => {
    const { container } = render(<GithubConnectionBanner state="ok" manage />);
    expect(container.textContent).toBe("");
  });
});
