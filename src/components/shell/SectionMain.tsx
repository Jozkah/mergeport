"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { sectionFor } from "@/lib/section";

/** The page area, tagged with the section it belongs to so its panels and icons take that section's hue. */
export function SectionMain({ children }: { children: ReactNode }) {
  return <main id="main" data-section={sectionFor(usePathname())} className="min-w-0 flex-1 px-4 pb-16 pt-6 lg:px-6">{children}</main>;
}
