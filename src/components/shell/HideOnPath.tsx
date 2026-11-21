"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Renders its children everywhere except on the given path (and below it). The layout stays a Server Component: it passes the
 * already rendered banner in, and this client wrapper only decides whether to show it for the current page.
 */
export function HideOnPath({ path, children }: { path: string; children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === path || pathname?.startsWith(`${path}/`)) return null;
  return <>{children}</>;
}
