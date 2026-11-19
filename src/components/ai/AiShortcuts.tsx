import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { getAiView } from "@/lib/services/ai";
import type { ReactNode } from "react";

/** A row of AI shortcut buttons for the top of a page. Shows nothing until the AI endpoint is set up, and nothing in the demo. */
export async function AiShortcuts({ children, className = "mb-4" }: { children: ReactNode; className?: string }) {
  if (isDemo() || !(await getAiView(db)).saved) return null;
  return <div className={`flex flex-wrap gap-x-4 gap-y-3 ${className}`}>{children}</div>;
}
