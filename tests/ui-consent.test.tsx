// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  let release!: (v: { ok: true; message: string; data: Record<string, unknown> }) => void;
  const wait = new Promise<{ ok: true; message: string; data: Record<string, unknown> }>((r) => (release = r));
  return { approve: vi.fn(() => wait), deny: vi.fn(async () => ({ ok: true as const, message: "Denied. Nothing was shared.", data: {} })), release: (v: { ok: true; message: string; data: Record<string, unknown> }) => release(v) };
});
vi.mock("@/app/federation-actions", () => ({ approveFederationAction: h.approve, denyFederationAction: h.deny, startLinkAction: vi.fn() }));

import { ConsentForms } from "@/components/federation/FederationForms";

afterEach(cleanup);

const fields = { clientOrigin: "https://peer.example", redirectUri: "https://peer.example/federation/callback", state: "s", codeChallenge: "c", csrf: "t" };

describe("the consent page", () => {
  it("is one form with two buttons; Approve cannot be clicked twice, Deny is off while Approve is pending, and both stay off until the redirect", async () => {
    const { container } = render(<ConsentForms fields={fields} workspaces={[{ id: "w1", name: "Acme", role: "MEMBER" }]} />);
    expect(container.querySelectorAll("form")).toHaveLength(1);
    const approve = screen.getByRole("button", { name: /Approve read-only access/ });
    const deny = screen.getByRole("button", { name: /Deny/ });
    expect(approve.closest("form")).toBe(deny.closest("form"));

    await act(async () => { fireEvent.click(approve); });
    await waitFor(() => expect(approve.hasAttribute("aria-disabled")).toBe(true));
    expect(deny.hasAttribute("aria-disabled")).toBe(true);
    await act(async () => { fireEvent.click(approve); fireEvent.click(deny); });
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.deny).not.toHaveBeenCalled();

    // The answer arrives (no address to leave to in this test): the buttons stay disabled, the outcome is said in words.
    await act(async () => { h.release({ ok: true, message: "Approved. Returning to the other instance…", data: { redirect: "https://peer.example/federation/callback?code=x" } }); });
    await waitFor(() => expect(screen.getByText("Approved. Returning to the other instance…")).toBeTruthy());
    expect(approve.hasAttribute("aria-disabled")).toBe(true);
    expect(deny.hasAttribute("aria-disabled")).toBe(true);
  });

  it("an approval without an http(s) address is an error with a way out, not a button stuck on Redirecting", async () => {
    cleanup();
    h.approve.mockImplementationOnce(async () => ({ ok: true as const, message: "Approved.", data: { redirect: "/relative/only" } }));
    render(<ConsentForms fields={fields} workspaces={[{ id: "w1", name: "Acme", role: "MEMBER" }, { id: "w2", name: "Beta", role: "ADMIN" }]} />);
    const approve = screen.getByRole("button", { name: /Approve read-only access/ });
    await act(async () => { fireEvent.click(approve); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("cannot be opened"));
    expect(approve.hasAttribute("aria-disabled")).toBe(false);
  });
});
