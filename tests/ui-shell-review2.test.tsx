// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { GettingStarted, type Step } from "@/components/onboarding/GettingStarted";
import { crumbsFor } from "@/components/shell/Topbar";
import { Banner } from "@/components/ui/primitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push() {}, refresh() {} }), useSearchParams: () => new URLSearchParams() }));

beforeAll(() => {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p.hasPointerCapture ??= () => false;
  p.setPointerCapture ??= () => {};
  p.releasePointerCapture ??= () => {};
  p.scrollIntoView ??= () => {};
  (globalThis as Record<string, unknown>).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

describe("breadcrumbs", () => {
  it("names members and linked, and a linked project has no dead link above it", () => {
    expect(crumbsFor("/settings/members").map((c) => c.label)).toEqual(["Settings", "Members"]);
    expect(crumbsFor("/linked")).toEqual([{ href: "/linked", label: "Linked instances" }]);
    const c = crumbsFor("/linked/abc123/projects/def456");
    expect(c.map((x) => x.label)).toEqual(["Linked instances", "Project"]);
    expect(c[0].href).toBe("/linked");
    // every link except the last must be a page that exists: the list, never /linked/<id> or /linked/<id>/projects
    expect(c.slice(0, -1).every((x) => x.href === "/linked")).toBe(true);
  });
});

describe("ConfirmSheet", () => {
  it("opens with focus on Cancel, wraps user text in the consequence, and puts the danger button last on sm+ (DOM: Cancel before it)", async () => {
    render(
      <ConfirmSheet title="Revoke?" consequence={<><bdi>long.email@example.com</bdi> loses access.</>} action={async () => ({ ok: true })} submitLabel="Revoke" trigger={<button type="button">Open</button>} />,
    );
    await act(async () => { fireEvent.click(screen.getByText("Open")); });
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    const danger = screen.getByRole("button", { name: "Revoke" });
    expect(cancel.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("long.email@example.com").tagName).toBe("BDI");
  });
});

describe("GettingStarted", () => {
  const steps: Step[] = [
    { key: "a", title: "Connect", why: "w", href: "/x", cta: "Go", done: true },
    { key: "b", title: "Invite", why: "w", href: "/y", cta: "Go", done: false },
  ];
  it("renders nothing at all when the server says it was dismissed (no pop-in after hydration)", () => {
    const { container } = render(<GettingStarted steps={steps} dismissed />);
    expect(container.innerHTML).toBe("");
  });
  it("puts the dismiss button in the header row beside the text and says which steps are done", () => {
    render(<GettingStarted steps={steps} />);
    const header = screen.getByRole("heading", { name: /Get started/ }).parentElement!.parentElement!;
    expect(header.className).not.toContain("flex-wrap");
    expect(header.querySelector('button[aria-label="Hide this guide"]')!.className).toContain("shrink-0");
    expect(screen.getByText("Done:").className).toContain("sr-only");
  });
});

describe("Banner", () => {
  it("info is neutral, not the blue needs-my-review state", () => {
    render(<Banner tone="info" title="Heads up" />);
    const el = screen.getByRole("status");
    expect(el.className).toContain("banner-info");
    expect(el.className).not.toContain("pill-needs");
  });
});
