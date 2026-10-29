"use client";

import { Avatar } from "@/components/ui/Avatar";
import { Logo } from "@/components/ui/Logo";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState, type ComponentType, type SVGProps } from "react";
import * as D from "@radix-ui/react-dialog";
import { Activity, BellRing, ChevronDown, CircleDot, FolderGit2, GitBranch, GitFork, GitPullRequest, Kanban, Layers, LayoutDashboard, PanelLeft, RefreshCw, Route, Search, Settings, Users, X } from "@/components/ui/icons";
import { Collapse } from "@/components/ui/Collapse";
import { Metric } from "@/components/ui/Metric";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
type Item = { href: string; label: string; icon: Icon; count?: number; children?: { href: string; label: string; count?: number }[] };

export type NavCounts = { needsMyReview: number; waiting: number; changes: number; blocked: number; needsTeam: number };

function buildNav(c: NavCounts, isAdmin: boolean) {
  const main: Item[] = [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    {
      href: "/attention",
      label: "My attention",
      icon: BellRing,
      count: c.needsMyReview,
      children: [
        { href: "/attention?queue=needs-me", label: "Needs my review", count: c.needsMyReview },
        { href: "/attention?queue=team", label: "Needs team review", count: c.needsTeam },
        { href: "/attention?queue=waiting", label: "Waiting on others", count: c.waiting },
        { href: "/attention?queue=changes", label: "Changes requested", count: c.changes },
        { href: "/attention?queue=blocked", label: "Blocked", count: c.blocked },
      ],
    },
    { href: "/pull-requests", label: "Pull requests", icon: GitPullRequest },
    { href: "/issues", label: "Issues", icon: CircleDot },
    {
      href: "/planning",
      label: "Planning",
      icon: Kanban,
      children: [
        { href: "/planning?view=board", label: "Board" },
        { href: "/planning?view=list", label: "List" },
        { href: "/planning?view=roadmap", label: "Roadmap" },
      ],
    },
    { href: "/activity", label: "Activity", icon: Activity },
  ];
  const source: Item[] = [
    { href: "/repositories", label: "Repositories", icon: FolderGit2 },
    { href: "/forks", label: "Forks & upstream", icon: GitFork },
    { href: "/branches", label: "Branches & worktrees", icon: GitBranch },
  ];
  const team: Item[] = [
    { href: "/team", label: "Team", icon: Users },
    { href: "/sync", label: "Sync", icon: RefreshCw },
  ];
  const admin: Item[] = isAdmin
    ? [
        { href: "/admin/projects", label: "Projects", icon: Layers },
        { href: "/admin/rules", label: "Review routing", icon: Route },
      ]
    : [];
  return { main, source, team, admin };
}

function NavList({ items, onNavigate }: { items: Item[]; onNavigate?: () => void }) {
  const path = usePathname();
  const sp = useSearchParams();
  const full = path + (sp.toString() ? `?${sp.toString()}` : "");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const uid = useId(); // the drawer renders a second copy of the navigation; ids must stay unique
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href.split("?")[0] || path.startsWith(href.split("?")[0] + "/"));
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((it) => {
        const I = it.icon;
        const active = isActive(it.href);
        const expanded = open[it.href] ?? active;
        return (
          <li key={it.href}>
            <div className="relative">
              <Link href={it.href} className="nav-item" aria-current={active && !it.children ? "page" : undefined} onClick={onNavigate}>
                <I size={16} aria-hidden className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {!it.children && it.count ? <span className="rounded-full bg-ink px-1.5 text-[11px] leading-[18px] text-ink-invert"><Metric value={it.count} /></span> : null}
              </Link>
              {it.children && (
                <button type="button" className="btn btn-quiet btn-icon absolute right-1 top-1 !h-8 !w-8" aria-label={`${expanded ? "Collapse" : "Expand"} ${it.label}`} aria-expanded={expanded} aria-controls={`${uid}-sub-${it.href.replace(/\W/g, "")}`} onClick={() => setOpen((s) => ({ ...s, [it.href]: !expanded }))}>
                  <ChevronDown size={14} aria-hidden className="chevron" data-open={expanded} />
                </button>
              )}
            </div>
            {it.children && (
              <Collapse open={expanded} id={`${uid}-sub-${it.href.replace(/\W/g, "")}`}>
              <ul className="ml-[18px] mt-0.5 flex flex-col gap-0.5 border-l border-line pl-3">
                {it.children.map((c) => {
                  const act = full === c.href;
                  return (
                    <li key={c.href}>
                      <Link href={c.href} className="nav-item !text-[12.5px]" aria-current={act ? "page" : undefined} onClick={onNavigate}>
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.count ? <span className="text-[11.5px] text-ink-3"><Metric value={c.count} /></span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              </Collapse>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 px-2.5 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">{label}</p>
      {children}
    </div>
  );
}

function SidebarBody({ counts, isAdmin, user, onNavigate, workspace }: { counts: NavCounts; isAdmin: boolean; user: { login: string; name: string | null; avatarUrl: string | null }; onNavigate?: () => void; workspace: string }) {
  const nav = buildNav(counts, isAdmin);
  const searchId = `${useId()}-search`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 px-3 pb-3 pt-3">
      <div className="flex items-center gap-2.5 px-1">
        <Logo size={32} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium leading-4">Mergeport</p>
          <p className="truncate text-[11.5px] text-ink-3" title={workspace}>{workspace}</p>
        </div>
      </div>
      <form action="/search" role="search" className="relative">
        <label htmlFor={searchId} className="sr-only">Search repositories, pull requests and issues</label>
        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-[9px] text-ink-3" />
        <input id={searchId} name="q" type="search" placeholder="Search anything" className="input !pl-8" autoComplete="off" />
      </form>
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-0.5">
        <Group label="Main navigation"><NavList items={nav.main} onNavigate={onNavigate} /></Group>
        <Group label="Source"><NavList items={nav.source} onNavigate={onNavigate} /></Group>
        <Group label="Collaboration"><NavList items={nav.team} onNavigate={onNavigate} /></Group>
        {nav.admin.length > 0 && <Group label="Administration"><NavList items={nav.admin} onNavigate={onNavigate} /></Group>}
      </nav>
      <Link href="/settings" onClick={onNavigate} className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface p-2 shadow-hair transition-colors duration-[var(--duration-feedback)] hover:bg-subtle">
        <Avatar login={user.login} url={user.avatarUrl} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-4">{user.name ?? user.login}</span>
          <span className="block truncate text-[11.5px] text-ink-3">@{user.login}</span>
        </span>
        <Settings size={14} aria-hidden className="shrink-0 text-ink-3" />
      </Link>
    </div>
  );
}

type SidebarProps = { counts: NavCounts; isAdmin: boolean; user: { login: string; name: string | null; avatarUrl: string | null }; workspace: string };

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[250px] shrink-0 lg:block" aria-label="Sidebar">
      <SidebarBody {...props} />
    </aside>
  );
}

/** Below lg the sidebar is a named, focus-trapped sheet opened from the top bar. */
export function MobileNav(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lg:hidden">
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Trigger className="btn btn-icon" aria-label="Open navigation">
          <PanelLeft size={16} aria-hidden />
        </D.Trigger>
        <D.Portal>
          <D.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
          <D.Content className="drawer-left fixed inset-y-0 left-0 z-50 w-[min(300px,88vw)] border-r border-line bg-canvas shadow-pop">
            <D.Title className="sr-only">Navigation</D.Title>
            <D.Description className="sr-only">Primary navigation</D.Description>
            <D.Close className="btn btn-quiet btn-icon absolute right-2 top-2" aria-label="Close navigation"><X size={16} aria-hidden /></D.Close>
            <SidebarBody {...props} onNavigate={() => setOpen(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>
    </div>
  );
}
