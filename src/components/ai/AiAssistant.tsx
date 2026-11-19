"use client";

import Link from "next/link";
import { useState } from "react";
import { Progress, useAiJob } from "@/components/ai/progress";
import { DraftTasks } from "@/components/tasks/AiTasks";
import { AiTool } from "@/components/ai/AiTool";
import { ReviewTab, type Suggestion } from "@/components/ai/ReviewTab";
import { Panel } from "@/components/ui/primitives";
import { Sparkles } from "@/components/ui/icons";

type P = { id: string; name: string };
type Source = { label: string; href: string | null };
type Turn = { q: string; a: string; model: string; sources: Source[] } | { q: string; error: string };

/** Two things in one place: ask about a pull request or issue, or turn notes into tasks. */
export function AiAssistant({ configured, projects, defaultProjectId, suggestions, summary, lastRun, autopilot, initialTab }: { initialTab?: "review" | "ask" | "tasks" | "brief"; configured: boolean; projects: P[]; defaultProjectId: string; suggestions: Suggestion[]; summary: string | null; lastRun: string | null; autopilot: "off" | "suggest" | "create" }) {
  const [mode, setMode] = useState<"review" | "ask" | "tasks" | "brief">(initialTab ?? (suggestions.length > 0 ? "review" : "ask"));
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const job = useAiJob();
  const pending = job.running;

  if (!configured) {
    return (
      <Panel title="Set up the AI endpoint" icon={Sparkles} id="ai-setup">
        <p className="p-4 text-[13px] text-ink-2">Add the address and key in <Link className="underline" href="/settings#ai">Settings</Link>. The model is picked automatically.</p>
      </Panel>
    );
  }

  const ask = async () => {
    const question = q.trim();
    if (!question || job.running) return;
    const r = await job.run<{ answer: string; model: string; sources: Source[] }>("/api/ai/ask", { question });
    const turn: Turn = r.ok ? { q: question, a: r.data.answer, model: r.data.model, sources: r.data.sources } : { q: question, error: r.error };
    setTurns((t) => [turn, ...t]);
    if (r.ok) setQ("");
  };

  return (
    <div className="max-w-2xl">
      <div role="tablist" aria-label="What to do" className="mb-3 flex gap-1.5">
        {([["review", suggestions.length ? `Review (${suggestions.length})` : "Review"], ["ask", "Ask a question"], ["tasks", "Draft tasks"], ["brief", "Briefings"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} className={`btn ${mode === k ? "bg-faint font-medium text-ink" : "btn-quiet"}`} onClick={() => setMode(k)}>{label}</button>
        ))}
      </div>
      {mode === "review" ? (
        <ReviewTab initial={suggestions} summary={summary} lastRun={lastRun} autopilot={autopilot} />
      ) : mode === "brief" ? (
        <Panel title="Briefings" icon={Sparkles} id="ai-brief">
          <div className="flex flex-col gap-5 p-4">
            <AiTool tool="standup" label="Write my stand-up" hint="Yesterday, today and what is blocked, from your latest digest and what is waiting on you." />
            <AiTool tool="digest" label="Brief me on my latest digest" hint="A short morning summary of your daily digest." />
            <p className="text-[12px] text-ink-3">For one pull request or issue, open it and press &ldquo;Where does this stand?&rdquo;.</p>
          </div>
        </Panel>
      ) : mode === "tasks" ? (
        <Panel title="Draft tasks" icon={Sparkles} id="ai-tasks">
          {projects.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">Create a project first; tasks live in a project.</p>
          ) : (
            <div className="p-4"><DraftTasks projects={projects} defaultProjectId={defaultProjectId} configured /></div>
          )}
        </Panel>
      ) : (
        <>
          <Panel title="Ask" icon={Sparkles} id="ai-ask">
            <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); if (!pending) ask(); }}>
              <label className="label" htmlFor="ai-q">Your question</label>
              <textarea id="ai-q" className="input min-h-20" rows={3} value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="e.g. What is the status of PR 3 from atlas-api?" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!pending) ask(); } }} />
              <p className="text-[12px] text-ink-3">Works best with a number and a repository or person, such as &ldquo;PR 3 from northwind/atlas-api&rdquo; or &ldquo;issue 12 by alice&rdquo;. The matching items are sent to the AI address in Settings.</p>
              <div><button type="submit" className="btn btn-primary" disabled={pending || !q.trim()}>{pending ? "Working…" : "Ask"}</button></div>
              <Progress steps={job.steps} running={job.running} elapsed={job.elapsed} />
            </form>
          </Panel>
          <ul className="mt-4 flex flex-col gap-3" aria-live="polite">
            {turns.map((t, i) => (
              <li key={i} className="rounded-[12px] border border-line p-3.5 text-[13px]">
                <p className="text-ink-3">{t.q}</p>
                {"error" in t ? (
                  <p role="alert" className="mt-1.5 text-blocked">{t.error}</p>
                ) : (
                  <>
                    <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{t.a}</p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                      {t.sources.length ? <>From {t.sources.map((s) => (s.href ? <Link key={s.label} href={s.href} className="underline">{s.label}</Link> : <span key={s.label}>{s.label}</span>))}</> : "No matching items found."}
                      {t.model && <span>· {t.model}</span>}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
