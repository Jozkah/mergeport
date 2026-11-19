"use client";

import Link from "next/link";
import { AiTool } from "@/components/ai/AiTool";
import { Sheet } from "@/components/ui/dialog";
import { ChevronRight, Sparkles } from "@/components/ui/icons";

/** The AI, one click from every page: a button in the top bar that opens a side panel with the quick jobs and what is waiting for you. */
export function AiQuick({ suggestions, requests }: { suggestions: number; requests: number }) {
  const waiting = suggestions + requests;
  return (
    <Sheet
      side="right"
      title="AI"
      description="Short answers from what Mergeport already stores. Nothing is changed and nothing goes to GitHub."
      trigger={
        <button type="button" className="btn btn-quiet btn-icon relative" aria-label={waiting ? `AI, ${waiting} waiting for you` : "AI"} title="AI">
          <Sparkles size={16} aria-hidden />
          {waiting > 0 && <span className="tnum absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[11px] leading-4 text-ink-invert">{waiting}</span>}
        </button>
      }
    >
      <div data-no-glow className="flex flex-col gap-5">
        <AiTool tool="focus" label="What should I do first?" hint="From your review queues and tasks." />
        <AiTool tool="standup" label="Write my stand-up" hint="Yesterday, today, blocked." />
        <AiTool tool="digest" label="Summarize my digest" hint="A short read of your latest digest." />
        <nav aria-label="More from the AI" className="flex flex-col border-t border-line pt-2 text-[13px]">
          {requests > 0 && <Link href="/ai?tab=approvals" className="group flex min-h-10 items-center justify-between gap-2"><span className="link"><span className="tnum">{requests}</span> request{requests === 1 ? "" : "s"} from AI apps to approve</span><ChevronRight size={14} aria-hidden className="text-ink-3" /></Link>}
          {suggestions > 0 && <Link href="/ai" className="group flex min-h-10 items-center justify-between gap-2"><span className="link"><span className="tnum">{suggestions}</span> suggested task{suggestions === 1 ? "" : "s"} to review</span><ChevronRight size={14} aria-hidden className="text-ink-3" /></Link>}
          <Link href="/ai?tab=ask" className="flex min-h-10 items-center justify-between gap-2"><span className="link">Ask about a pull request</span><ChevronRight size={14} aria-hidden className="text-ink-3" /></Link>
          <Link href="/ai?tab=tasks" className="flex min-h-10 items-center justify-between gap-2"><span className="link">Turn notes into tasks</span><ChevronRight size={14} aria-hidden className="text-ink-3" /></Link>
        </nav>
      </div>
    </Sheet>
  );
}
