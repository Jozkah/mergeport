// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix needs a few browser APIs jsdom does not have.
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

const gate = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

describe("SubmitButton", () => {
  it("cannot send a form twice: it is disabled and busy while the action is pending, and keeps both labels in the layout", async () => {
    const g = gate();
    let calls = 0;
    render(
      <form action={async () => { calls++; await g.p; }}>
        <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
      </form>,
    );
    const btn = screen.getByRole("button");
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(btn.hasAttribute("aria-disabled")).toBe(true));
    expect(btn.getAttribute("aria-busy")).toBe("true");
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(calls).toBe(1);
    // Both labels are in the DOM (one invisible), so the button keeps the width of the longer one and nothing jumps.
    expect(btn.textContent).toContain("Send");
    expect(btn.textContent).toContain("Sending…");
    await act(async () => { g.release(); });
    await waitFor(() => expect(btn.hasAttribute("aria-disabled")).toBe(false));
  });
});

describe("ActionForm result lifecycle", () => {
  const ok: ActionResult = { ok: true, message: "Saved it" };

  it("a success line clears itself after about four seconds, and the input stays what it was", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ActionForm action={async () => ok} submitLabel="Save" resetOnSuccess={false}><input aria-label="name" defaultValue="x" /></ActionForm>);
    await act(async () => { fireEvent.submit(screen.getByRole("button").closest("form")!); });
    await waitFor(() => expect(screen.getByText("Saved it")).toBeTruthy());
    await act(async () => { vi.advanceTimersByTime(3500); });
    expect(screen.queryByText("Saved it")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(screen.queryByText("Saved it")).toBeNull();
  });

  it("an error stays until the next edit, then goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ActionForm action={async () => ({ ok: false, error: "Nope" })} submitLabel="Save"><input aria-label="name" /></ActionForm>);
    await act(async () => { fireEvent.submit(screen.getByRole("button").closest("form")!); });
    await waitFor(() => expect(screen.getByText("Nope")).toBeTruthy());
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.queryByText("Nope")).not.toBeNull();
    await act(async () => { fireEvent.input(screen.getByLabelText("name"), { target: { value: "y" } }); });
    expect(screen.queryByText("Nope")).toBeNull();
  });

  it("onDone returning true keeps the button pending and says Redirecting", async () => {
    render(<ActionForm action={async () => ok} submitLabel="Go" pendingLabel="Going…" onDone={() => true}><input aria-label="n" /></ActionForm>);
    const btn = screen.getByRole("button");
    await act(async () => { fireEvent.submit(btn.closest("form")!); });
    await waitFor(() => expect(btn.hasAttribute("aria-disabled")).toBe(true));
    expect(btn.textContent).toContain("Redirecting…");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(btn.hasAttribute("aria-disabled")).toBe(true); // still held: the page is about to leave
  });

  it("requireDirty keeps the button off until a field differs from what loaded", async () => {
    render(<ActionForm action={async () => ok} submitLabel="Save" requireDirty resetOnSuccess={false}><input aria-label="n" name="n" defaultValue="a" /></ActionForm>);
    const btn = screen.getByRole("button");
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(true));
    await act(async () => { fireEvent.input(screen.getByLabelText("n"), { target: { value: "b" } }); });
    expect(btn.hasAttribute("disabled")).toBe(false);
    await act(async () => { fireEvent.input(screen.getByLabelText("n"), { target: { value: "a" } }); });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });
});

describe("Select", () => {
  const open = async (trigger: HTMLElement) => { await act(async () => { fireEvent.keyDown(trigger, { key: "Enter" }); }); };
  const pick = async (name: string) => {
    const opt = await screen.findByRole("option", { name });
    await act(async () => { fireEvent.keyDown(opt, { key: "Enter" }); });
  };

  it("posts the chosen value and goes back to the default when the form is reset", async () => {
    const { container } = render(
      <form>
        <Select name="role" defaultValue="b" aria-label="Role"><option value="a">A</option><option value="b">B</option><option value="c">C</option></Select>
      </form>,
    );
    const form = container.querySelector("form")!;
    const posted = () => new FormData(form).get("role");
    expect(posted()).toBe("b");
    await open(screen.getByRole("combobox"));
    await pick("C");
    expect(posted()).toBe("c");
    await act(async () => { form.reset(); });
    expect(posted()).toBe("b"); // the hidden input does not keep the old id
  });

  it("autoSubmit submits the form when a different option is chosen, with the new value already in it", async () => {
    const seen: string[] = [];
    const { container } = render(
      <form onSubmit={(e) => { e.preventDefault(); seen.push(String(new FormData(e.currentTarget).get("role"))); }}>
        <Select name="role" defaultValue="a" autoSubmit aria-label="Role"><option value="a">A</option><option value="b">B</option></Select>
      </form>,
    );
    expect(container).toBeTruthy();
    await open(screen.getByRole("combobox"));
    await pick("B");
    expect(seen).toEqual(["b"]);
    // choosing the value it already has does not submit again
    await open(screen.getByRole("combobox"));
    await pick("B");
    expect(seen).toEqual(["b"]);
  });

  it("required blocks the form while nothing is chosen", () => {
    const { container } = render(
      <form>
        <Select name="who" defaultValue="" required aria-label="Who"><option value="">Choose…</option><option value="x">X</option></Select>
      </form>,
    );
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(false);
  });

  it("is valid once something is chosen", () => {
    const { container } = render(
      <form>
        <Select name="who" defaultValue="x" required aria-label="Who"><option value="">Choose…</option><option value="x">X</option></Select>
      </form>,
    );
    expect((container.querySelector("form") as HTMLFormElement).checkValidity()).toBe(true);
  });
});

describe("ConfirmSheet", () => {
  it("Cancel closes it without running the action; the danger button runs it once", async () => {
    const action = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    render(
      <ConfirmSheet title="Remove Ann?" consequence="Ann loses access." action={action} submitLabel="Remove" trigger={<button type="button">Open</button>}>
        <input type="hidden" name="id" value="1" />
      </ConfirmSheet>,
    );
    await act(async () => { fireEvent.click(screen.getByText("Open")); });
    expect(await screen.findByText("Ann loses access.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    await waitFor(() => expect(screen.queryByText("Ann loses access.")).toBeNull());
    expect(action).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByText("Open")); });
    const go = await screen.findByRole("button", { name: "Remove" });
    await act(async () => { fireEvent.submit(go.closest("form")!); });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});
