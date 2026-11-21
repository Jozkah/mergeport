// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({ pathname: "/", hosted: true }));
vi.mock("next/navigation", () => ({ usePathname: () => m.pathname }));
vi.mock("@/lib/public-url", () => ({ isHosted: () => m.hosted }));

import { Banner } from "@/components/ui/primitives";
import { GithubConnectionBanner } from "@/components/shell/GithubConnectionBanner";
import { HideOnPath } from "@/components/shell/HideOnPath";
import { ASK_ADMIN_TO_TRACK, ConnectReposEmpty, ConnectReposLink, canConnectRepos } from "@/components/repos/ConnectRepos";

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  m.pathname = "/";
  m.hosted = true;
});

describe("Banner with an action", () => {
  it("stacks the action under the text below sm and keeps them side by side from sm", () => {
    const { container } = render(<Banner title="T" action={<a className="btn" href="/x">Go</a>}>Body</Banner>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("flex-wrap");
    expect(root.className).toContain("sm:flex-nowrap");
    const action = container.querySelector("[data-banner-action]") as HTMLElement;
    expect(action.className).toContain("w-full");
    expect(action.className).toContain("order-last");
    expect(action.className).toContain("sm:order-none");
    expect(action.className).toContain("sm:w-auto");
    expect(action.className).toContain("max-sm:[&_.btn]:!h-10");
    expect(action.querySelector("a")?.textContent).toBe("Go");
  });
  it("a banner without an action keeps the plain row", () => {
    const { container } = render(<Banner title="T">Body</Banner>);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("flex-wrap");
    expect(container.querySelector("[data-banner-action]")).toBeNull();
  });
  it("the dismiss button stays in the row beside the text, ahead of the stacked action in order", () => {
    const { container } = render(<Banner title="T" dismissible action={<a className="btn" href="/x">Go</a>}>Body</Banner>);
    const root = container.firstElementChild as HTMLElement;
    const kids = Array.from(root.children);
    const dismiss = screen.getByRole("button", { name: /Dismiss/ });
    expect(kids.indexOf(dismiss)).toBe(kids.length - 1);
    expect(kids[kids.length - 2].hasAttribute("data-banner-action")).toBe(true);
    expect((kids[kids.length - 2] as HTMLElement).className).toContain("order-last");
  });
  it("the GitHub connection banner uses it in all three states", () => {
    for (const state of ["none", "suspended", "removed"] as const) {
      const { container, unmount } = render(<GithubConnectionBanner state={state} manage />);
      expect(container.querySelector("[data-banner-action] a")).toBeTruthy();
      unmount();
    }
  });
});

describe("Connect repositories is admin-only on a hosted workspace", () => {
  it("canConnectRepos: hosted admin yes, hosted member no, local always", () => {
    m.hosted = true;
    expect(canConnectRepos({ isAdmin: true })).toBe(true);
    expect(canConnectRepos({ isAdmin: false })).toBe(false);
    m.hosted = false;
    expect(canConnectRepos({ isAdmin: false })).toBe(true);
  });
  it("the link renders for an administrator and not for anyone else", () => {
    render(<ConnectReposLink canConnect>Connect repositories</ConnectReposLink>);
    expect(screen.getByRole("link", { name: "Connect repositories" }).getAttribute("href")).toBe("/repositories/connect");
    cleanup();
    const { container } = render(<ConnectReposLink canConnect={false} />);
    expect(container.innerHTML).toBe("");
  });
  it("the empty state offers the link to an administrator and the plain explanation to others", () => {
    render(<ConnectReposEmpty canConnect title="No repositories yet">Import one.</ConnectReposEmpty>);
    expect(screen.getByRole("link", { name: "Connect repositories" })).toBeTruthy();
    expect(screen.getByText("Import one.")).toBeTruthy();
    cleanup();
    render(<ConnectReposEmpty canConnect={false} title="No repositories yet">Import one.</ConnectReposEmpty>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(ASK_ADMIN_TO_TRACK)).toBeTruthy();
    expect(ASK_ADMIN_TO_TRACK).toBe("Ask the owner or an administrator to track a repository, and to give you access to it.");
  });
});

describe("sentence case in the GitHub UI", () => {
  it("'Open repositories' and no Title Case button labels in the connect files", () => {
    const files = ["src/components/repos/HostedConnect.tsx", "src/app/(app)/repositories/connect/page.tsx"];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain('label: "Open repositories"');
      expect(src).not.toContain("Open Repositories");
    }
    for (const f of [...files, "src/components/settings/GithubPanels.tsx", "src/components/shell/GithubConnectionBanner.tsx", "src/app/(app)/settings/github/page.tsx"]) {
      const labels = [...readFileSync(f, "utf8").matchAll(/(?:submitLabel|label|title)[=:]\s*[{]?"([^"]+)"/g)].map((x) => x[1]);
      for (const l of labels) expect(l, `${f}: ${l}`).not.toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)+$/);
    }
  });
});

describe("GitHub connection banner on the GitHub settings page", () => {
  const ui = () => <HideOnPath path="/settings/github"><GithubConnectionBanner state="none" manage /></HideOnPath>;
  it("is not rendered on /settings/github", () => {
    m.pathname = "/settings/github";
    const { container } = render(ui());
    expect(container.innerHTML).toBe("");
  });
  it("is rendered everywhere else", () => {
    for (const p of ["/", "/repositories", "/settings", "/settings/members", "/settings/githubby"]) {
      m.pathname = p;
      render(ui());
      expect(screen.getByText("GitHub is not connected yet"), p).toBeTruthy();
      cleanup();
    }
  });
});
