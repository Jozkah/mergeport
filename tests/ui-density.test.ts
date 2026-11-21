import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

// Shared density primitives (PageHeader help, panel summary, dismissible Banner, ViewBar, Sidebar). Server-rendered markup only.

const nav = vi.hoisted(() => ({ path: "/team" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/app/view-actions", () => ({ saveViewAction: async () => ({ ok: true }), shareViewAction: async () => ({ ok: true }), deleteViewAction: async () => ({ ok: true }) }));

const { Banner, PageHeader, Panel } = await import("@/components/ui/primitives");
const { isDismissed, rememberDismissal } = await import("@/components/ui/DismissibleBanner");
const { ViewBar } = await import("@/components/views/ViewBar");
const { Sidebar } = await import("@/components/shell/Sidebar");

afterEach(() => {
  vi.unstubAllGlobals();
  nav.path = "/team";
});

describe("PageHeader", () => {
  it("clamps the subtitle to two lines with the full text on hover", () => {
    const html = renderToStaticMarkup(h(PageHeader, { title: "Team", subtitle: "A long subtitle" }));
    expect(html).toMatch(/<p class="[^"]*line-clamp-2[^"]*" title="A long subtitle">A long subtitle<\/p>/);
    expect(html).not.toContain("<details");
  });

  it("puts help in a closed, natively keyboard-operable disclosure with a 40px summary", () => {
    const html = renderToStaticMarkup(h(PageHeader, { title: "Team", help: "Why this page exists" }));
    expect(html).toMatch(/<details class="[^"]*"><summary class="[^"]*h-10[^"]*">.*About this page.*<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("Why this page exists"); // in the markup, revealed by the browser on toggle (click, Enter or Space)
    expect(html).not.toMatch(/duration-\[\d|transition-all/);
  });
});

describe("Panel summary", () => {
  it("shows the summary only while closed and still renders the closed body", () => {
    const closed = renderToStaticMarkup(h(Panel, { id: "p", title: "Waiting", defaultOpen: false, summary: "owner-demo, 20h", children: "body text" }));
    expect(closed).toContain("owner-demo, 20h");
    expect(closed).toContain("body text");
    expect(closed).toMatch(/data-open="false" inert=""/);
    const open = renderToStaticMarkup(h(Panel, { id: "p", title: "Waiting", summary: "owner-demo, 20h", children: "body text" }));
    expect(open).not.toContain("owner-demo, 20h");
    expect(open).toContain("body text");
  });
});

describe("Banner", () => {
  it("is unchanged when not dismissible", () => {
    const html = renderToStaticMarkup(h(Banner, { title: "Stale" }, "details"));
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<script");
  });

  it("renders a labelled 40px close button and a pre-paint check for an earlier dismissal", () => {
    const html = renderToStaticMarkup(h(Banner, { title: "Stale", dismissible: true, storageKey: "stale" }));
    expect(html).toMatch(/<button[^>]*aria-label="Dismiss: Stale"[^>]*!h-10 !w-10/);
    const script = html.match(/<script>(.*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("mp.banner.stale");
    const run = (storage: unknown) => {
      const el = { hidden: false };
      runInNewContext(script, { localStorage: storage, document: { currentScript: { previousElementSibling: el } } });
      return el.hidden;
    };
    expect(run({ getItem: (k: string) => (k === "mp.banner.stale" ? "1" : null) })).toBe(true);
    expect(run({ getItem: () => null })).toBe(false);
    expect(run({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });

  it("remembers a dismissal per key and survives broken storage", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
    expect(isDismissed("a")).toBe(false);
    expect(rememberDismissal("a")).toBe(true);
    expect(isDismissed("a")).toBe(true);
    expect(isDismissed("b")).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } });
    expect(isDismissed("a")).toBe(false);
    expect(rememberDismissal("a")).toBe(false);
  });
});

describe("ViewBar", () => {
  it("shows only a quiet Save view action when there are no views", () => {
    const html = renderToStaticMarkup(h(ViewBar, { scope: "prs", views: [] }));
    expect(html).not.toContain("No saved views");
    expect(html).toContain(">Save view</button>");
  });
});

describe("Sidebar", () => {
  it("has one Planning link and no per-view children", () => {
    nav.path = "/planning";
    const counts = { needsMyReview: 0, waiting: 0, changes: 0, blocked: 0, needsTeam: 0 };
    const html = renderToStaticMarkup(h(Sidebar, { counts, isAdmin: true, user: { login: "u", name: null, avatarUrl: null }, workspace: "w" }));
    expect(html).toContain('href="/planning"');
    expect(html).not.toMatch(/planning\?view=/);
    expect(html).not.toContain("Expand Planning");
  });
});
