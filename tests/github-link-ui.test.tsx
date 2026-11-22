// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";
import { LINK_MESSAGES, LINK_PURPOSE, LINK_RESULTS, isLinkResult } from "@/lib/github/link-messages";
import { resetGithubAppConfigCache } from "@/lib/github/app-config";
import { FakeGitHubServer } from "@/lib/github/fake-server";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  start: vi.fn(async (): Promise<ActionResult> => ({ ok: true, data: { redirect: "https://github.com/login/oauth/authorize?client_id=x&state=s" } })),
  unlink: vi.fn(async (): Promise<ActionResult> => ({ ok: true, message: "done" })),
  check: vi.fn(async (): Promise<ActionResult> => ({ ok: true, message: "asked" })),
}));
vi.mock("@/app/github-link-actions", () => ({ startGithubLinkAction: m.start, unlinkGithubAction: m.unlink, checkGithubAccessAction: m.check }));
// The connect forms (imported for their redirect helper) pull in their own actions.
vi.mock("@/app/github-actions", () => ({ startGithubConnectAction: vi.fn(), disconnectGithubInstallationAction: vi.fn(), checkGithubInstallationAction: vi.fn() }));

import { GithubAccountBody, type GithubAccountView } from "@/components/settings/GithubAccountPanel";
import { LinkGithubBanner } from "@/components/settings/LinkGithubBanner";

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
  vi.unstubAllEnvs();
  m.start.mockReset();
  m.start.mockImplementation(async () => ({ ok: true, data: { redirect: "https://github.com/login/oauth/authorize?client_id=x&state=s" } }));
});

const FORBIDDEN = /this computer|GitHub CLI|\bgh\b|later task|coming soon|not implemented|placeholder|\bphase\b|TODO|token|OAuth|PKCE|MERGEPORT_/i;
const view = (o: Partial<GithubAccountView> = {}): GithubAccountView => ({ available: true, link: null, timezone: "UTC", ...o });
const body = (v: GithubAccountView, result: Parameters<typeof GithubAccountBody>[0]["result"] = null) => render(<GithubAccountBody view={v} result={result} />);
const submitButton = (name: string) => screen.getAllByRole("button", { name }).find((b) => b.getAttribute("type") === "submit")!;
const alerts = () => screen.getAllByRole("alert").map((a) => a.textContent ?? "").join(" | ");

describe("Settings > GitHub account panel", () => {
  it("not linked: one plain sentence on what it is used for and 'Link GitHub' as the primary action", () => {
    const { container } = body(view());
    expect(container.textContent).toContain("Mergeport uses it to see which repositories you can open on GitHub; it does not post anything.");
    expect(submitButton("Link GitHub").className).toMatch(/btn-primary/);
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("linked: shows @login, the time of the last check, 'Check again' and Unlink; no jargon", () => {
    const { container } = body(view({ link: { login: "octo", state: "ok", checkedAt: new Date("2026-11-20T10:30:00Z") } }));
    expect(container.textContent).toContain("@octo");
    expect(container.textContent).toMatch(/Access checked\s*Nov 20, 10:30/);
    expect(submitButton("Check again")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link GitHub" })).toBeNull();
    const chip = screen.getByText("Linked");
    expect(chip.className).toMatch(/pill-ok/);
    expect(chip.querySelector("svg")).not.toBeNull(); // colour never stands alone
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("a check that could not list everything says so", () => {
    const { container } = body(view({ link: { login: "octo", state: "ok", checkedAt: new Date("2026-11-20T10:30:00Z"), truncated: true } }));
    expect(container.textContent).toContain("Showing access for the first 5,000 repositories.");
    cleanup();
    const complete = body(view({ link: { login: "octo", state: "ok", checkedAt: new Date("2026-11-20T10:30:00Z"), truncated: false } }));
    expect(complete.container.textContent).not.toContain("Showing access for the first");
  });

  it("linked but never checked says so", () => {
    body(view({ link: { login: "octo", state: "ok", checkedAt: null } }));
    expect(screen.getByText("Access not checked yet")).toBeTruthy();
  });

  it("needs relinking: a neutral chip with an icon, a plain explanation, 'Link GitHub' and Unlink", () => {
    const { container } = body(view({ link: { login: "octo", state: "relink", checkedAt: new Date() } }));
    const chip = screen.getByText("Needs relinking");
    expect(chip.className).toMatch(/pill-waiting/);
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toMatch(/no longer accepts the link/);
    expect(submitButton("Link GitHub")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull(); // nothing to check until it is linked again
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it("not available on this server: no button, a sentence that says who to ask", () => {
    const { container } = body(view({ available: false }));
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toMatch(/not available on this server yet/);
    expect(container.textContent).toMatch(/person who runs this server/);
  });

  it("a very long login is one truncated line with the full text available", () => {
    const long = "x".repeat(39);
    const { container } = body(view({ link: { login: long, state: "ok", checkedAt: null } }));
    const name = container.querySelector(`[title="${long}"]`)!;
    expect(name.className).toMatch(/truncate/);
    expect(name.className).toMatch(/max-w-full/);
  });
});

describe("result messages", () => {
  it("every code has a fixed message and none holds a token, code, account name or number", () => {
    for (const c of LINK_RESULTS) {
      const r = LINK_MESSAGES[c];
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.body.length).toBeGreaterThan(10);
      expect(`${r.title} ${r.body}`).not.toMatch(FORBIDDEN);
      expect(`${r.title} ${r.body}`).not.toMatch(/ghu_|ghr_|ghs_|client secret|\d{3,}/i);
    }
  });

  it("only known codes are recognised: a query value is never shown", () => {
    expect(isLinkResult("linked")).toBe(true);
    for (const bad of ["<script>alert(1)</script>", "../..", "LINKED", "", undefined, null, 5, ["linked"]]) expect(isLinkResult(bad)).toBe(false);
  });

  it("an error is announced as an alert, a success as a status", () => {
    body(view(), LINK_MESSAGES["github-taken"]);
    expect(alerts()).toMatch(/already linked to someone else/);
    expect(alerts()).toMatch(/ask the other person to unlink it first/);
    cleanup();
    body(view(), LINK_MESSAGES.linked);
    expect(screen.getAllByRole("status").map((x) => x.textContent).join(" | ")).toMatch(/GitHub account linked/);
  });

  it("the purpose sentence is the one in the spec", () => {
    expect(LINK_PURPOSE).toBe("Mergeport uses it to see which repositories you can open on GitHub; it does not post anything.");
  });
});

describe("actions", () => {
  it("'Link GitHub' calls the start action and goes to GitHub only for an https address", async () => {
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    try {
      body(view());
      await act(async () => { fireEvent.submit(submitButton("Link GitHub").closest("form")!); });
      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?client_id=x&state=s"));
      expect(m.start).toHaveBeenCalledTimes(1);

      cleanup(); // the first button stays on "Redirecting…" while the page is leaving
      body(view());
      m.start.mockResolvedValueOnce({ ok: true, data: { redirect: "javascript:alert(1)" } });
      await act(async () => { fireEvent.submit(submitButton("Link GitHub").closest("form")!); });
      await waitFor(() => expect(alerts()).toMatch(/Nothing was linked/));
      expect(assign).toHaveBeenCalledTimes(1); // the unsafe address was never opened
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });

  it("a refusal from the action is shown as the message it carries", async () => {
    m.start.mockResolvedValueOnce({ ok: false, error: "Your GitHub account is already linked." });
    body(view());
    await act(async () => { fireEvent.submit(submitButton("Link GitHub").closest("form")!); });
    await waitFor(() => expect(alerts()).toMatch(/already linked/));
  });

  it("'Check again' calls the check action", async () => {
    body(view({ link: { login: "octo", state: "ok", checkedAt: null } }));
    await act(async () => { fireEvent.submit(submitButton("Check again").closest("form")!); });
    await waitFor(() => expect(m.check).toHaveBeenCalledTimes(1));
  });

  it("Unlink asks first: names the consequence, focuses Cancel, and only the danger button runs the action", async () => {
    body(view({ link: { login: "octo", state: "ok", checkedAt: null } }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Unlink" })); });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unlink your GitHub account?")).toBeTruthy();
    expect(dialog.textContent).toMatch(/hidden from you again, unless an administrator gave you access/);
    expect(dialog.textContent).toMatch(/Nothing changes on GitHub/);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    const danger = within(dialog).getByRole("button", { name: "Unlink" });
    expect(danger.className).toMatch(/btn-danger/);
    await act(async () => { fireEvent.click(cancel); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.unlink).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Unlink" })); });
    const again = await screen.findByRole("dialog");
    await act(async () => { fireEvent.submit(within(again).getByRole("button", { name: "Unlink" }).closest("form")!); });
    await waitFor(() => expect(m.unlink).toHaveBeenCalledTimes(1));
  });
});

describe("the 'Link GitHub' action on My attention and Inbox", () => {
  const env = () => {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.test");
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("MERGEPORT_GITHUB_APP_ID", "1");
    vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "mergeport-test");
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", "Iv1.testclient01");
    vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", "s".repeat(40));
    vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "w".repeat(32));
  };

  it("where linking is not possible (local app) the banner is the plain note with no button", () => {
    const { container } = render(<LinkGithubBanner>Team queues still show.</LinkGithubBanner>);
    expect(container.textContent).toContain("Personal review queues need a linked GitHub account.");
    expect(container.textContent).toContain("Team queues still show.");
    expect(container.querySelector("form")).toBeNull();
  });

  it("hosted, App set up and an encryption key: the banner carries a 'Link GitHub' button that starts the flow", async () => {
    env();
    vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", new FakeGitHubServer().registerApp("1").privateKeyPem);
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "k".repeat(40));
    resetGithubAppConfigCache();
    try {
      const { container } = render(<LinkGithubBanner>Team queues still show.</LinkGithubBanner>);
      const btn = submitButton("Link GitHub");
      expect(btn.className).not.toMatch(/btn-primary/);
      expect(container.textContent).toContain("Personal review queues need a linked GitHub account.");
      await act(async () => { fireEvent.submit(btn.closest("form")!); });
      await waitFor(() => expect(m.start).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllEnvs();
      resetGithubAppConfigCache();
    }
  });

  it("without an encryption key the banner has no button either (linking would only fail)", () => {
    env();
    vi.stubEnv("MERGEPORT_ENCRYPTION_KEY", "");
    const { container } = render(<LinkGithubBanner>Team queues still show.</LinkGithubBanner>);
    expect(container.querySelector("form")).toBeNull();
  });
});
