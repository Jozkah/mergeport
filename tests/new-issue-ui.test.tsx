// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  create: vi.fn(async (_fd: FormData): Promise<ActionResult> => ({ ok: true, message: "Issue #7 created on GitHub", data: { href: "/issues/wi-7" } })),
  preview: vi.fn(async (body: string): Promise<ActionResult> => ({ ok: true, data: { html: `<p>${body.replace(/\n/g, "<br />")}</p>` } })),
  push: vi.fn(),
}));
vi.mock("@/app/actions", () => ({ createIssueAction: m.create, previewMarkdownAction: m.preview }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }), usePathname: () => "/issues/new" }));

import { NewIssueForm, type NewIssueRepo } from "@/components/work/NewIssueForm";

const KEY = "mergeport:new-issue-draft:user-1";
const repos: NewIssueRepo[] = [
  { id: "r1", fullName: "acme/web", isDemo: false, refusal: null },
  { id: "r2", fullName: "acme/api", isDemo: false, refusal: "Writing to GitHub is turned off for this workspace." },
  { id: "r3", fullName: "demo/playground", isDemo: true, refusal: null },
];
const form = (preselect: string | null = null) => render(<NewIssueForm repos={repos} preselect={preselect} draftKey={KEY} />);
const combo = () => screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: "Create issue" }) as HTMLButtonElement;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, string> | null;

beforeAll(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView ??= () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("new issue page", () => {
  it("searches repositories by typing and chooses one with the keyboard", () => {
    form();
    const c = combo();
    fireEvent.change(c, { target: { value: "API" } });
    expect(c.getAttribute("aria-expanded")).toBe("true");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["acme/apicannot write here"]);
    expect(c.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.change(c, { target: { value: "acme" } });
    fireEvent.keyDown(c, { key: "ArrowDown" });
    fireEvent.keyDown(c, { key: "Enter" });
    expect(c.value).toBe("acme/api");
    expect(c.getAttribute("aria-expanded")).toBe("false");
    expect((document.querySelector('input[name="repositoryId"]') as HTMLInputElement).value).toBe("r2");
    // the refusal is shown, and the form cannot be sent there
    expect(screen.getByText("Issues cannot be created in acme/api from here right now")).toBeTruthy();
    expect(screen.getAllByText("Writing to GitHub is turned off for this workspace.").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Broken" } });
    expect(submit().disabled).toBe(true);
    fireEvent.keyDown(c, { key: "Escape" });
  });

  it("?repo preselects; labels only apply to demo repositories", () => {
    form("r1");
    expect(combo().value).toBe("acme/web");
    expect((screen.getByLabelText(/Labels/) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    form("r3");
    expect((screen.getByLabelText(/Labels/) as HTMLInputElement).disabled).toBe(false);
  });

  it("autosaves a draft (debounced), restores it on return, and Discard draft clears it", async () => {
    vi.useFakeTimers();
    const first = form();
    fireEvent.change(combo(), { target: { value: "web" } });
    fireEvent.keyDown(combo(), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Login loops" } });
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "one\ntwo" } });
    expect(stored()).toBeNull(); // not yet: debounced
    await act(async () => vi.advanceTimersByTime(1000));
    expect(stored()).toEqual({ repoId: "r1", title: "Login loops", body: "one\ntwo", labels: "" });
    expect(m.create).not.toHaveBeenCalled(); // nothing is posted while typing
    first.unmount();

    form();
    expect(combo().value).toBe("acme/web");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Login loops");
    expect(document.querySelector("textarea")!.value).toBe("one\ntwo");
    expect(screen.getByText("Draft restored")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(stored()).toBeNull();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(stored()).toBeNull();
  });

  it("?repo wins over the draft's repository; a broken draft is ignored", () => {
    localStorage.setItem(KEY, JSON.stringify({ repoId: "r1", title: "T", body: "", labels: "" }));
    form("r3");
    expect(combo().value).toBe("demo/playground");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("T");
    cleanup();
    localStorage.setItem(KEY, "{not json");
    form();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
  });

  it("Preview renders the body with line breaks; submitting from Preview posts the body with its newlines, clears the draft and opens the issue", async () => {
    form("r1");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Broken" } });
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "line one\nline two" } });
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Preview" }).innerHTML).toContain("line one<br>line two"));
    expect(m.preview).toHaveBeenCalledWith("line one\nline two");
    localStorage.setItem(KEY, JSON.stringify({ repoId: "r1", title: "Broken", body: "x", labels: "" }));
    fireEvent.click(submit());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    const fd = m.create.mock.calls[0][0];
    expect(fd.get("repositoryId")).toBe("r1");
    expect(fd.get("title")).toBe("Broken");
    expect(fd.get("body")).toBe("line one\nline two");
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/issues/wi-7"));
    expect(stored()).toBeNull();
  });
});
