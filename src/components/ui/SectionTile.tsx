"use client";

import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import { Activity, BellRing, FolderGit2, Kanban, LayoutDashboard, ListChecks, GitPullRequest, Users } from "@/components/ui/icons";
import { sectionFor, type Section } from "@/lib/section";

const ICON: Record<Section, ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>> = {
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
  const I = path.startsWith("/activity") ? Activity : ICON[s];
  return (
    <span data-section={s} aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border" style={{ color: "var(--sec)", background: "color-mix(in srgb, var(--sec) 12%, var(--color-surface))", borderColor: "color-mix(in srgb, var(--sec) 28%, var(--color-line))" }}>
      <I size={18} />
    </span>
  );
}
