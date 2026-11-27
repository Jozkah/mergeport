// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "@/lib/action-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  create: vi.fn(async (_fd: FormData): Promise<ActionResult> => ({ ok: true, data: { href: "/issues/x" } })),
  run: vi.fn(async (_url: string, _body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => ({ ok: true, data: { title: "Login loops", body: "## Steps\n1. Sign in", sources: ["acme/web"] } })),
}));
vi.mock("@/app/actions", () => ({ createIssueAction: m.create, previewMarkdownAction: vi.fn(), mentionSuggestionsAction: vi.fn(async () => ({ ok: true, data: { items: [] } })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/issues/new" }));
vi.mock("@/components/ai/progress", () => ({ useAiJob: () => ({ steps: [], running: false, elapsed: 0, run: m.run }), Progress: () => null }));

import { NewIssueForm, type NewIssueRepo } from "@/components/work/NewIssueForm";

const repos: NewIssueRepo[] = [{ id: "r1", fullName: "acme/web", isDemo: false, refusal: null }];
const visible = [{ id: "r1", fullName: "acme/web" }, { id: "r9", fullName: "acme/docs" }];
const form = (enabled = true) => render(<NewIssueForm repos={repos} preselect="r1" draftKey="k" ai={{ enabled, repos: visible }} />);
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "Draft with AI" }));
const title = () => screen.getByLabelText("Title") as HTMLInputElement;
const body = () => document.querySelector('textarea[name="body"]') as HTMLTextAreaElement;

beforeAll(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView ??= () => {};
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Draft with AI on the new issue page", () => {
  it("fills title and body from the prompt, with research on this repository, and never submits", async () => {
    form();
    openPanel();
    fireEvent.change(screen.getByLabelText("What should the issue be about?"), { target: { value: "login loops" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(title().value).toBe("Login loops"));
    expect(body().value).toBe("## Steps\n1. Sign in");
    expect(m.run).toHaveBeenCalledWith("/api/ai/issue-draft", { repositoryId: "r1", prompt: "login loops", research: "repo", otherRepoIds: [] });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("other projects: sends the picked repositories", async () => {
    form();
    openPanel();
    fireEvent.change(screen.getByLabelText("What should the issue be about?"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText("This repository and other projects"));
    fireEvent.click(screen.getByLabelText("acme/docs"));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(m.run).toHaveBeenCalledWith("/api/ai/issue-draft", { repositoryId: "r1", prompt: "x", research: "others", otherRepoIds: ["r9"] }));
  });

  it("asks before overwriting: Append keeps the title and adds to the description; Replace replaces both", async () => {
    form();
    fireEvent.change(title(), { target: { value: "Mine" } });
    fireEvent.change(body(), { target: { value: "my text" } });
    openPanel();
    fireEvent.change(screen.getByLabelText("What should the issue be about?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => screen.getByRole("button", { name: "Append" }));
    expect(title().value).toBe("Mine");
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(title().value).toBe("Mine");
    expect(body().value).toBe("my text\n\n## Steps\n1. Sign in");

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(title().value).toBe("Login loops");
    expect(body().value).toBe("## Steps\n1. Sign in");
  });

  it("text typed while the model works is not overwritten without asking", async () => {
    let resolve!: (v: { ok: true; data: unknown }) => void;
    m.run.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    form();
    openPanel();
    fireEvent.change(screen.getByLabelText("What should the issue be about?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.change(title(), { target: { value: "Typed meanwhile" } });
    resolve({ ok: true, data: { title: "Login loops", body: "B", sources: [] } });
    await waitFor(() => screen.getByRole("button", { name: "Append" }));
    expect(title().value).toBe("Typed meanwhile");
  });

  it("shows the error and leaves the form as it was", async () => {
    m.run.mockResolvedValueOnce({ ok: false, error: "Set up the AI endpoint in Settings first." });
    form();
    openPanel();
    fireEvent.change(screen.getByLabelText("What should the issue be about?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByText("Set up the AI endpoint in Settings first.").getAttribute("role")).toBe("alert"));
    expect(title().value).toBe("");
  });

  it("when the AI is not set up, says so and links to Settings instead of a prompt", () => {
    form(false);
    openPanel();
    expect(screen.getByText(/The AI is not set up for this workspace/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings#ai");
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });
});
