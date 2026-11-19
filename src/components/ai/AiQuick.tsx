"use client";

import Link from "next/link";
import { AiTool } from "@/components/ai/AiTool";
import { Sheet } from "@/components/ui/dialog";
import { Sparkles } from "@/components/ui/icons";

/** The AI shortcuts, one click from every page: a button in the top bar that opens a side panel with the quick jobs. */
export function AiQuick({ pending }: { pending: number }) {
  return (
    <Sheet
      side="right"
      title="AI shortcuts"
      description="Short answers from what Mergeport already stores. Nothing is changed and nothing goes to GitHub."
      trigger={
        <button type="button" className="btn btn-quiet btn-icon relative" aria-label={pending ? `AI shortcuts, ${pending} suggested task${pending === 1 ? "" : "s"}` : "AI shortcuts"} title="AI shortcuts">
          <Sparkles size={16} aria-hidden />
          {pending > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] leading-4 text-ink-invert">{pending}</span>}
        </button>
      }
    >
      <div className="flex flex-col gap-5">
        <AiTool tool="focus" label="What should I do first?" hint="From your review queues, pull requests and tasks." />
        <AiTool tool="standup" label="Write my stand-up" hint="Yesterday, today, blocked." />
        <AiTool tool="digest" label="Brief me on my digest" hint="A short summary of your latest daily digest." />
        <div className="flex flex-col gap-1.5 border-t border-line pt-4 text-[13px]">
          <Link href="/ai?tab=review" className="link">Review my workspace{pending ? ` (${pending} suggested)` : ""}</Link>
          <Link href="/ai?tab=ask" className="link">Ask about a pull request</Link>
          <Link href="/ai?tab=tasks" className="link">Draft tasks from notes</Link>
        </div>
      </div>
    </Sheet>
  );
}
