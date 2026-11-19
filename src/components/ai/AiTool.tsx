"use client";

import Link from "next/link";
import { useState } from "react";
import { Progress, useAiJob } from "@/components/ai/progress";
import { Sparkles } from "@/components/ui/icons";

type Result = { title: string; text: string; model: string; sources: { label: string; href: string }[] };

/** One small read-only AI job (briefing, stand-up, where an item stands). It reads what Mergeport already stores and writes a short text; nothing is changed. */
export function AiTool({ tool, label, id, day, hint, className = "" }: { tool: "digest" | "standup" | "item"; label: string; id?: string; day?: string; hint?: string; className?: string }) {
  const job = useAiJob();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    const r = await job.run<Result>("/api/ai/tool", { tool, id, day });
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={run} disabled={job.running}><Sparkles size={14} aria-hidden /> {job.running ? "Working…" : label}</button>
        {hint && !result && !job.running && <span className="text-[12px] text-ink-3">{hint}</span>}
      </div>
      {job.running && <Progress steps={job.steps} running elapsed={job.elapsed} />}
      {error && <p role="alert" className="text-[12.5px] text-blocked">{error}</p>}
      {result && !job.running && (
        <section className="rounded-[12px] border border-line p-4" aria-label={result.title}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[12px] font-medium text-ink-3">{result.title}</p>
            <button type="button" className="btn btn-quiet !h-7 !px-2 !text-[12px]" onClick={() => setResult(null)}>Hide</button>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 [overflow-wrap:anywhere]">{result.text}</p>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            From {result.sources.map((s) => <Link key={s.href} href={s.href} className="underline">{s.label}</Link>)} <span>· {result.model}</span> <span>· made by AI from stored data, check before relying on it</span>
          </p>
        </section>
      )}
    </div>
  );
}
