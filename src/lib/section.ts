/**
 * Each part of the app has one hue, used only for wayfinding: the sidebar entry, the icons in panel headings, the hatching of the
 * panel frames and empty states. Status colours (needs review, waiting, blocked, ok) keep their own meaning and never take it.
 */
export type Section = "overview" | "attention" | "tasks" | "work" | "planning" | "source" | "team";

export function sectionFor(path: string): Section {
  const p = path.split("?")[0];
  if (p.startsWith("/attention") || p.startsWith("/inbox")) return "attention";
  if (p.startsWith("/tasks")) return "tasks";
  if (p.startsWith("/pull-requests") || p.startsWith("/issues")) return "work";
  if (p.startsWith("/planning")) return "planning";
  if (p.startsWith("/repositories") || p.startsWith("/forks") || p.startsWith("/branches")) return "source";
  if (p.startsWith("/help") || p.startsWith("/team") || p.startsWith("/sync") || p.startsWith("/admin") || p.startsWith("/settings") || p.startsWith("/join")) return "team";
  return "overview";
}
