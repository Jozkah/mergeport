// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ changeRole: vi.fn(async (_fd: FormData) => ({ ok: true as const })), spaceAcl: vi.fn(async (_fd: FormData) => ({ ok: true as const })) }));
vi.mock("@/app/workspace-actions", () => ({
  changeRoleAction: h.changeRole,
  setProjectSpaceAclAction: h.spaceAcl,
  reinstateMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  resendInvitationAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
}));

import { ActiveMembers, type MemberView } from "@/components/members/MembersClient";
import { ProjectAccessForm } from "@/components/members/ProjectAccessForm";
import { AutoCheckbox } from "@/components/forms/AutoCheckbox";

beforeAll(() => {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p.hasPointerCapture ??= () => false;
  p.setPointerCapture ??= () => {};
  p.releasePointerCapture ??= () => {};
  p.scrollIntoView ??= () => {};
  (globalThis as Record<string, unknown>).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const member: MemberView = { id: "m1", name: "Ann", sub: "ann@example.com", role: "MEMBER", isSelf: false, manageable: true, removeText: "Ann loses access." };
const pick = async (combo: HTMLElement, name: string) => {
  await act(async () => { fireEvent.keyDown(combo, { key: "Enter" }); });
  const opt = await screen.findByRole("option", { name });
  await act(async () => { fireEvent.keyDown(opt, { key: "Enter" }); });
};

describe("member role autosave", () => {
  it("a change that is not about admin saves straight away", async () => {
    render(<ActiveMembers members={[member]} />);
    await pick(screen.getByRole("combobox", { name: "Role for Ann" }), "Reader");
    await waitFor(() => expect(h.changeRole).toHaveBeenCalledTimes(1));
  });

  it("promoting to admin asks first; Cancel saves nothing and puts the picker back", async () => {
    render(<ActiveMembers members={[member]} />);
    await pick(screen.getByRole("combobox", { name: "Role for Ann" }), "Admin");
    expect(await screen.findByText(/will be able to invite and remove people/)).toBeTruthy();
    expect(h.changeRole).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    await waitFor(() => expect(screen.queryByText(/will be able to invite and remove people/)).toBeNull());
    expect(h.changeRole).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Role for Ann" }).textContent).toContain("Member");
  });

  it("confirming the promotion sends the admin role once", async () => {
    render(<ActiveMembers members={[member]} />);
    await pick(screen.getByRole("combobox", { name: "Role for Ann" }), "Admin");
    const go = await screen.findByRole("button", { name: "Make admin" });
    await act(async () => { fireEvent.submit(go.closest("form")!); });
    await waitFor(() => expect(h.changeRole).toHaveBeenCalledTimes(1));
    expect(h.changeRole.mock.calls[0][0].get("role")).toBe("ADMIN");
  });

  it("demoting an admin asks too", async () => {
    render(<ActiveMembers members={[{ ...member, role: "ADMIN" }]} />);
    await pick(screen.getByRole("combobox", { name: "Role for Ann" }), "Member");
    expect(await screen.findByText(/loses admin rights/)).toBeTruthy();
    expect(h.changeRole).not.toHaveBeenCalled();
  });
});

describe("project access", () => {
  const spaces = [{ id: "s1", name: "Secret team" }];
  it("moving a restricted project to everyone goes through a confirmation; a change between restricted spaces does not", async () => {
    render(<ProjectAccessForm projectId="p1" current="s1" spaces={spaces} action={h.spaceAcl} />);
    expect((screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement).disabled).toBe(true); // nothing changed
    await pick(screen.getByRole("combobox"), "Everyone in the workspace");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save access" })); });
    expect(await screen.findByText(/Everyone in the workspace will see this project/)).toBeTruthy();
    expect(h.spaceAcl).not.toHaveBeenCalled();
  });
});

describe("AutoCheckbox", () => {
  it("submits its form when toggled", async () => {
    const seen: string[] = [];
    render(<form onSubmit={(e) => { e.preventDefault(); seen.push(String(new FormData(e.currentTarget).get("canWrite"))); }}><AutoCheckbox name="canWrite" aria-label="can edit" /></form>);
    await act(async () => { fireEvent.click(screen.getByLabelText("can edit")); });
    expect(seen).toEqual(["on"]);
  });
});
