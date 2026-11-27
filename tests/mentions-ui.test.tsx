// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  suggest: vi.fn(async (i: { repositoryId: string; kind: string; query: string }): Promise<ActionResult> => ({
    ok: true,
    data: {
      items:
        i.kind === "user"
          ? [{ kind: "user", login: "alice", avatar: null }, { kind: "user", login: "alfred", avatar: null }]
          : [{ kind: "item", number: 12, title: "Fix login", type: "PULL_REQUEST", state: "OPEN", href: "/pull-requests/x" }],
    },
  })),
}));
vi.mock("@/app/actions", () => ({ mentionSuggestionsAction: m.suggest }));

import { MentionTextarea } from "@/components/work/MentionTextarea";

function Box({ repo = "r1" }: { repo?: string | null }) {
  const [v, setV] = useState("");
  return <MentionTextarea repositoryId={repo} aria-label="Body" value={v} onValueChange={setV} />;
}
const box = () => screen.getByLabelText("Body") as HTMLTextAreaElement;
const type = (el: HTMLTextAreaElement, value: string) => {
  el.focus();
  fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
};

beforeAll(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mention popup", () => {
  it("suggests people for @, moves with arrows and inserts with Enter at the caret", async () => {
    render(<Box />);
    const el = box();
    type(el, "hi @al");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(m.suggest).toHaveBeenCalledWith({ repositoryId: "r1", kind: "user", query: "al" });
    expect(el.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(el.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(el.value).toBe("hi @alfred ");
    expect(el.selectionStart).toBe(11);
    expect(screen.queryByRole("listbox")).toBeNull(); // hidden
  });

  it("suggests issues and pull requests for #, and a click inserts", async () => {
    render(<Box />);
    type(box(), "see #1");
    const opt = await screen.findByRole("option");
    expect(opt.textContent).toContain("#12");
    expect(opt.textContent).toContain("Fix login");
    fireEvent.mouseDown(opt);
    expect(box().value).toBe("see #12 ");
  });

  it("closes on Escape so Enter makes a new line again, and asks nothing without a repository", async () => {
    render(<Box />);
    type(box(), "@al");
    await screen.findAllByRole("option");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
    type(box(), "");
    type(box(), "@al"); // a new mention at the same place opens again
    expect(await screen.findAllByRole("option")).toHaveLength(2);
    cleanup();
    render(<Box repo={null} />);
    type(box(), "@al");
    await new Promise((r) => setTimeout(r, 300));
    expect(m.suggest).toHaveBeenCalledTimes(1);
  });
});
