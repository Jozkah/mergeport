"use client";

import { RingOnChange } from "@/components/ui/RingOnChange";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ChevronRight, LayoutDashboard, LogOut } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/shell/ThemeControls";
import { AccountWorkspaceSwitcher } from "@/components/shell/AccountWorkspaceSwitcher";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { Tip } from "@/components/ui/Tooltip";
import { Metric } from "@/components/ui/Metric";
import { SyncBadge, type SyncStateName } from "@/components/sync/SyncBadge";
import type { ThemePreference } from "@/lib/theme";

const LABELS: Record<string, string> = {
  attention: "My attention",
  inbox: "Inbox",
  digest: "Daily digest",
  "pull-requests": "Pull requests",
  issues: "Issues",
  planning: "Planning",
  tasks: "Tasks",
  activity: "Activity",
  ai: "AI assistant",
  repositories: "Repositories",
  connect: "Connect repositories",
  forks: "Forks",
  branches: "Branches",
  admin: "Admin",
  team: "Team",
  capacity: "Review capacity",
  sync: "Sync status",
  join: "Join a space",
  projects: "Projects",
  rules: "Who reviews what",
  labels: "Label taxonomy",
  settings: "Settings",
  help: "Help",
  search: "Search",
  members: "Members",
  linked: "Linked instances",
};

/** Breadcrumb trail for a path. Only segments that are pages get a link; ids and container segments are never dead links. */
export function crumbsFor(path: string): { href: string; label: string }[] {
  const parts = path.split("/").filter(Boolean);
  // /linked/<link>/projects/<project>: the list is the only page above the project.
  if (parts[0] === "linked" && parts.length > 1) {
    return [{ href: "/linked", label: LABELS.linked }, ...(parts.length > 3 ? [{ href: path, label: "Project" }] : [])];
  }
  return parts.map((p, i) => ({ href: "/" + parts.slice(0, i + 1).join("/"), label: LABELS[p] ?? (p.length > 16 ? "Detail" : p) }));
}

export function Topbar({ hosted, aiQuick, unread, menu, syncNote, theme, sync, scopePicker, accountSwitcher }: { hosted?: boolean; aiQuick?: React.ReactNode; accountSwitcher?: { workspaces: { id: string; name: string }[]; active: string } | null; scopePicker?: React.ReactNode; unread: number; menu: React.ReactNode; syncNote?: string; theme: ThemePreference; sync: { state: SyncStateName; pending: number; conflicts: number; detail?: string | null; scope?: "source" } | null }) {
  const path = usePathname();
  const crumbs = crumbsFor(path);
  return (
    <>
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/90 px-3 backdrop-blur-sm sm:gap-3 sm:px-4 lg:px-6">
      {menu}
      <nav aria-label="Breadcrumb" className="min-w-[6rem] flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-3">
          {/* On a narrow bar only the current page is named; the Overview link stays when there is no other crumb. */}
          <li className={`${crumbs.length ? "hidden sm:flex" : "flex"} shrink-0 items-center gap-1.5`}>
            <Link href="/" className="inline-flex items-center gap-1.5 hover:text-ink" aria-label="Overview">
              <LayoutDashboard size={14} aria-hidden />
              <span className="hidden sm:inline">Overview</span>
            </Link>
          </li>
          {crumbs.map((c, i) => (
            <li key={c.href} className={`${i === crumbs.length - 1 ? "flex" : "hidden sm:flex"} min-w-0 items-center gap-1.5`}>
              <ChevronRight size={12} aria-hidden className="hidden shrink-0 sm:block" />
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="truncate font-medium text-ink">{c.label}</span>
              ) : (
                <Link href={c.href} className="truncate hover:text-ink">{c.label}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {accountSwitcher ? <div className="hidden sm:block"><AccountWorkspaceSwitcher {...accountSwitcher} /></div> : null}
      {scopePicker ? <div className="hidden sm:block">{scopePicker}</div> : null}
      {syncNote && <span className="tnum hidden text-[12px] text-ink-3 md:inline">{syncNote}</span>}
      {sync && <SyncBadge {...sync} href="/sync" hosted={hosted} />}
      {aiQuick}
      <ThemeToggle initial={theme} />
      <Tip label={unread ? `Notifications (${unread} unread)` : "Notifications"}>
        <RingOnChange value={unread}>{(ring) => (
        <Link href="/activity" className="btn btn-quiet btn-icon bell-link relative" data-ring={ring ? "true" : undefined} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell size={16} aria-hidden />
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] leading-4 text-ink-invert"><Metric value={unread} /></span>}
        </Link>
        )}</RingOnChange>
      </Tip>
      <form action="/auth/signout" method="post">
        <Tip label="Sign out of this browser session"><SubmitButton iconOnly className="btn btn-quiet btn-icon" aria-label="Sign out"><LogOut size={16} aria-hidden /></SubmitButton></Tip>
      </form>
    </header>
    {/* Narrow screens have no room for more controls in the bar: scope and workspace get their own row under it. */}
    {scopePicker || accountSwitcher ? (
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 sm:hidden">
        {scopePicker ? <div className="min-w-0 flex-1">{scopePicker}</div> : null}
        {accountSwitcher ? <div className="min-w-0 flex-1"><AccountWorkspaceSwitcher {...accountSwitcher} className="w-full" /></div> : null}
      </div>
    ) : null}
    </>
  );
}
