"use client";

import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import { Activity, BellRing, CircleHelp, FolderGit2, Kanban, Layers, LayoutDashboard, ListChecks, GitPullRequest, RefreshCw, Route, Settings, Tag, Users } from "@/components/ui/icons";
import { sectionFor, type Section } from "@/lib/section";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

// Pages that share a section hue but are not about people get their own icon (the same one as their sidebar entry).
const PAGE_ICON: [prefix: string, icon: Icon][] = [
  ["/activity", Activity],
  ["/settings", Settings],
  ["/sync", RefreshCw],
  ["/help", CircleHelp],
  ["/admin/projects", Layers],
  ["/admin/rules", Route],
  ["/admin/labels", Tag],
];

const ICON: Record<Section, Icon> = {
  overview: LayoutDashboard,
  attention: BellRing,
  tasks: ListChecks,
  work: GitPullRequest,
  planning: Kanban,
  source: FolderGit2,
  team: Users,
};

/** The section's icon in its hue, beside the page title: where you are, at a glance. Decorative (the title says it in words). */
export function SectionTile() {
  const path = usePathname();
  const s = sectionFor(path);
  const I = PAGE_ICON.find(([p]) => path === p || path.startsWith(`${p}/`))?.[1] ?? ICON[s];
  return (
    <span data-section={s} aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border" style={{ color: "var(--sec)", background: "color-mix(in srgb, var(--sec) 12%, var(--color-surface))", borderColor: "color-mix(in srgb, var(--sec) 28%, var(--color-line))" }}>
      <I size={18} />
    </span>
  );
}
