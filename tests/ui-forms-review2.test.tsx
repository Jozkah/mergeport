// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { ActionForm } from "@/components/forms/ActionForm";
import { RedirectLink } from "@/components/forms/SubmitButton";
import { Select } from "@/components/ui/Select";
import { ExpiresOn } from "@/components/members/MembersClient";
import { Metric } from "@/components/ui/Metric";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.useRealTimers();
});

describe("ActionForm (review round 2)", () => {
  it("a resetOnSuccess form still shows its success line (the reset runs before the result is set)", async () => {
    render(<ActionForm action={async () => ({ ok: true, message: "Invitation sent" })} submitLabel="Invite"><input aria-label="email" name="email" defaultValue="" /></ActionForm>);
    fireEvent.input(screen.getByLabelText("email"), { target: { value: "a@b.c" } });
    await act(async () => { fireEvent.submit(screen.getByRole("button").closest("form")!); });
    await waitFor(() => expect(screen.getByText("Invitation sent")).toBeTruthy());
    expect((screen.getByLabelText("email") as HTMLInputElement).value).toBe("");
  });

  it("a rejected autosave puts the Select back on the stored value", async () => {
    const action = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: "Not allowed" }));
    render(
      <ActionForm action={action} submitLabel="Save" hideSubmit>
        <Select name="role" defaultValue="a" autoSubmit aria-label="Role"><option value="a">Alpha</option><option value="b">Beta</option></Select>
      </ActionForm>,
    );
    await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); });
    const opt = await screen.findByRole("option", { name: "Beta" });
    await act(async () => { fireEvent.keyDown(opt, { key: "Enter" }); });
    await waitFor(() => expect(action).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Not allowed")).toBeTruthy());
    expect(screen.getByRole("combobox").textContent).toContain("Alpha");
  });

  it("an inline row has no permanent status regions of reserved height; its error shows in the row", async () => {
    const { container } = render(<ActionForm action={async () => ({ ok: false, error: "Nope" })} submitLabel="Go" layout="inline"><input aria-label="n" /></ActionForm>);
    const status = container.querySelector('[role="status"]')!;
    const alert = container.querySelector('[role="alert"]')!;
    expect(status.className).not.toContain("min-h-5");
    expect(alert.className).not.toContain("min-h-5");
    await act(async () => { fireEvent.submit(container.querySelector("form")!); });
    await waitFor(() => expect(alert.textContent).toContain("Nope"));
  });

  it("a busy button stays focusable (aria-disabled, not disabled) and ignores a second press", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    render(<ActionForm action={async () => { calls++; await gate; return { ok: true }; }} submitLabel="Save" resetOnSuccess={false}><input aria-label="n" /></ActionForm>);
    const btn = screen.getByRole("button");
    btn.focus();
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(btn);
    await act(async () => { fireEvent.submit(btn.closest("form")!); });
    expect(calls).toBe(1);
    await act(async () => { release(); });
  });

  it("an error that names a field marks it invalid, describes it with the message and focuses it", async () => {
    render(<ActionForm action={async () => ({ ok: false, error: "Use a valid address", field: "email" })} submitLabel="Go"><input aria-label="email" name="email" /></ActionForm>);
    const input = screen.getByLabelText("email");
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    const alert = screen.getByRole("alert");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect(document.activeElement).toBe(input);
    await act(async () => { fireEvent.input(input, { target: { value: "x" } }); });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("a held 'Redirecting…' lets go after ten seconds when the page never left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ActionForm action={async () => ({ ok: true })} submitLabel="Go" onDone={() => true}><input aria-label="n" /></ActionForm>);
    const btn = screen.getByRole("button");
    await act(async () => { fireEvent.submit(btn.closest("form")!); });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("RedirectLink", () => {
  it("a new-tab click (ctrl/meta/middle) does not stick on Redirecting; a plain click does", () => {
    render(<RedirectLink href="/x">Go</RedirectLink>);
    const a = screen.getByRole("link");
    fireEvent.click(a, { ctrlKey: true });
    fireEvent.click(a, { metaKey: true });
    fireEvent.click(a, { button: 1 });
    expect(a.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(a);
    expect(a.getAttribute("aria-busy")).toBe("true");
  });
});

describe("Select (review round 2)", () => {
  it("a value that matches no option shows Unavailable, never the first option", () => {
    render(<Select name="s" defaultValue="gone" aria-label="Access"><option value="all">Everyone</option><option value="r">Restricted</option></Select>);
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Unavailable");
    expect(trigger.textContent).not.toContain("Everyone");
  });

  it("keeps width utilities on its wrapper and the proxy input anchored over the trigger", () => {
    const { container } = render(<form><Select name="s" required defaultValue="" aria-label="X" className="select w-32 !h-10"><option value="">Choose…</option><option value="a">A</option></Select></form>);
    const wrap = container.querySelector("form > span")!;
    expect(wrap.className).toContain("relative");
    expect(wrap.className).toContain("w-32");
    const trigger = screen.getByRole("combobox");
    expect(trigger.className).not.toContain("w-32");
    expect(container.querySelector("input[name=s]")!.className).toContain("inset-0");
  });
});

describe("ExpiresOn", () => {
  it("renders the same text on the server and in the browser, in a fixed format", () => {
    const iso = "2026-11-28T10:00:00.000Z";
    const server = renderToString(<ExpiresOn iso={iso} />);
    expect(server).toContain("Nov 28, 2026");
    const { container } = render(<ExpiresOn iso={iso} />);
    expect(container.textContent).toBe("Nov 28, 2026");
  });
});

describe("Metric", () => {
  it("typing does not count as an action on a number; a press does", async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(10_000); // earlier tests pressed keys: let that window pass
    const { rerender, container } = render(<Metric value={1} />);
    fireEvent.keyDown(document.body, { key: "a" });
    rerender(<Metric value={2} />);
    expect(container.querySelector(".num-in")).toBeNull();
    fireEvent.pointerDown(document.body);
    rerender(<Metric value={3} />);
    expect(container.querySelector(".num-in")).not.toBeNull();
  });
});
