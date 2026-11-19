"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearGlow, setGlow } from "@/lib/glow";
import { Progress, useAiJob } from "@/components/ai/progress";
import { useSheetClose } from "@/components/ui/dialog";
import { Sparkles } from "@/components/ui/icons";

type Step = { label: string; href: string; view: string; why: string };
type Result = { title: string; text: string; model: string; sources: { label: string; href: string }[]; steps?: Step[] };

/** One small read-only AI job (briefing, stand-up, where an item stands). It reads what Mergeport already stores and writes a short text; nothing is changed. */
export function AiTool({ tool, label, id, day, hint, className = "" }: { tool: "digest" | "standup" | "item" | "focus"; label: string; id?: string; day?: string; hint?: string; className?: string }) {
  const job = useAiJob();
  const router = useRouter();
  const closeSheet = useSheetClose(); // inside the top-bar panel, going somewhere closes it
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    const r = await job.run<Result>("/api/ai/tool", { tool, id, day });
    if (r.ok) {
      setResult(r.data);
      // Pull requests the AI pointed at glow on whatever page lists them, until you open them or turn it off.
      if (r.data.steps?.length) setGlow(r.data.steps.map((s) => s.href));
    } else setError(r.error);
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
          {result.steps && result.steps.length > 0 && (
            <>
              <ol className="mt-3 flex flex-col gap-2 text-[13px]">
                {result.steps.map((s, i) => (
                  <li key={s.href} className="flex items-start gap-2">
                    <span className="tnum mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[11px]">{i + 1}</span>
                    <span className="min-w-0"><Link href={s.href} className="font-medium underline">{s.label}</Link>{s.why && <span className="block text-[12px] text-ink-3">{s.why}</span>}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary !h-8" onClick={() => { closeSheet?.(); router.push(result.steps![0].view); }}>Show me where</button>
                <button type="button" className="btn btn-quiet !h-8" onClick={() => clearGlow()}>Stop highlighting</button>
              </div>
            </>
          )}
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            From {result.sources.map((s) => <Link key={s.href} href={s.href} className="underline">{s.label}</Link>)} <span>· {result.model}</span> <span>· made by AI from stored data, check before relying on it</span>
          </p>
        </section>
      )}
    </div>
  );
}
