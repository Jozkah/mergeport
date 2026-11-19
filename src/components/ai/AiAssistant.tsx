"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ApprovalsTab, type PendingRow } from "@/components/ai/ApprovalsTab";
import { Progress, useAiJob } from "@/components/ai/progress";
import { TodayTab, type Suggestion } from "@/components/ai/TodayTab";
import { DraftTasks } from "@/components/tasks/AiTasks";
import { EmptyState, Panel } from "@/components/ui/primitives";
import { FolderGit2, Sparkles } from "@/components/ui/icons";

type P = { id: string; name: string };
type Source = { label: string; href: string | null };
type Turn = { id: number; q: string; a: string; model: string; sources: Source[] } | { id: number; q: string; error: string };
type Tab = "today" | "ask" | "tasks" | "approvals";
const TABS: Tab[] = ["today", "ask", "tasks", "approvals"];
const fromUrl = (v: string | null | undefined): Tab | null => (v === "review" || v === "brief" ? "today" : TABS.find((t) => t === v) ?? null);

/**
 * One place for the AI: your day (review, suggestions, briefings), a question about a pull request, notes turned into tasks, and what
 * AI apps asked to do on GitHub. All four panels stay mounted, so what you typed or got back is still there when you come back to a tab.
 */
export function AiAssistant({ configured, projects, defaultProjectId, suggestions, summary, lastRun, autopilot, initialTab, approvals }: { approvals: PendingRow[]; initialTab?: string; configured: boolean; projects: P[]; defaultProjectId: string; suggestions: Suggestion[]; summary: string | null; lastRun: string | null; autopilot: "off" | "suggest" | "create" }) {
  const params = useSearchParams();
  const uid = useId();
  const [mode, setMode] = useState<Tab>(fromUrl(initialTab) ?? (approvals.length > 0 ? "approvals" : "today"));
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const job = useAiJob();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  // A link to /ai?tab=… from elsewhere (the shortcuts panel, the palette) while this page is open changes the tab.
  const urlTab = params.get("tab");
  const [seenTab, setSeenTab] = useState(urlTab);
  if (urlTab !== seenTab) {
    setSeenTab(urlTab);
    const t = fromUrl(urlTab);
    if (t) setMode(t);
  }

  if (!configured) {
    return (
      <Panel title="Set up the AI endpoint" icon={Sparkles} id="ai-setup">
        <p className="p-4 text-[13px] text-ink-2 text-pretty">Add the address and key in <Link className="link" href="/settings#ai">Settings</Link>. The model is picked automatically.</p>
      </Panel>
    );
  }

  const pick = (t: Tab) => {
    setMode(t);
    window.history.replaceState(null, "", t === "today" ? "/ai" : `/ai?tab=${t}`);
  };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(mode);
    const to = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    pick(to);
    tabs.current[to]?.focus();
  };

  const ask = async () => {
    const question = q.trim();
    if (!question || job.running) return;
    const r = await job.run<{ answer: string; model: string; sources: Source[] }>("/api/ai/ask", { question });
    const id = nextId.current++;
    const turn: Turn = r.ok ? { id, q: question, a: r.data.answer, model: r.data.model, sources: r.data.sources } : { id, q: question, error: r.error };
    setTurns((t) => [turn, ...t]);
    if (r.ok) setQ("");
  };

  const names: Record<Tab, string> = { today: "Today", ask: "Ask", tasks: "Draft tasks", approvals: "Approvals" };
  const panel = (t: Tab) => ({ id: `${uid}-panel-${t}`, role: "tabpanel" as const, "aria-labelledby": `${uid}-tab-${t}`, hidden: mode !== t, tabIndex: 0 });

  return (
    <div className="max-w-3xl">
      <div className="seg mb-4" role="tablist" aria-label="What to do">
        {TABS.map((t) => (
          <button key={t} ref={(el) => void (tabs.current[t] = el)} type="button" role="tab" id={`${uid}-tab-${t}`} aria-selected={mode === t} aria-controls={`${uid}-panel-${t}`} tabIndex={mode === t ? 0 : -1} onClick={() => pick(t)} onKeyDown={keys}>
            {names[t]}{t === "approvals" && approvals.length > 0 && <span className="tnum opacity-80"> ({approvals.length})</span>}
          </button>
        ))}
      </div>

      <div {...panel("today")}>
        <Panel title="Your day" icon={Sparkles} id="ai-today">
          <TodayTab initial={suggestions} summary={summary} lastRun={lastRun} autopilot={autopilot} />
        </Panel>
      </div>

      <div {...panel("ask")}>
        <Panel title="Ask about a pull request or issue" icon={Sparkles} id="ai-ask">
          <div data-no-glow>
            <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
              <label className="label" htmlFor="ai-q">Your question</label>
              <textarea id="ai-q" className="input min-h-20" rows={3} value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="e.g. What is the status of PR 3 from atlas-api?" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void ask(); } }} />
              <p className="text-[12px] text-ink-3 text-pretty">Include a number and a repository or person: &ldquo;PR 3 from northwind/atlas-api&rdquo;, &ldquo;issue 12 by alice&rdquo;. The matching items are sent to your AI address. Ctrl+Enter asks.</p>
              <div><button type="submit" className="btn btn-primary" aria-disabled={job.running} aria-busy={job.running} disabled={!q.trim()}>{job.running ? "Working…" : "Ask"}</button></div>
              <Progress steps={job.steps} running={job.running} elapsed={job.elapsed} />
            </form>
            {turns.length > 0 && (
              <ul className="flex flex-col border-t border-line" aria-label="Answers">
                {turns.map((t, i) => (
                  <li key={t.id} className={`${i === 0 ? "result-in" : ""} border-b border-line px-4 py-3 text-[13px] last:border-b-0`}>
                    <p className="text-ink-3 text-pretty [overflow-wrap:anywhere]">{t.q}</p>
                    {"error" in t ? (
                      <p role="alert" className="mt-1.5 text-blocked text-pretty">{t.error}</p>
                    ) : (
                      <>
                        <p className="mt-1.5 whitespace-pre-wrap text-pretty [overflow-wrap:anywhere]">{t.a}</p>
                        <p className="mt-2 text-[12px] text-ink-3 text-pretty">
                          {t.sources.length ? <>From {t.sources.map((s) => (s.href ? <Link key={s.label} href={s.href} data-no-glow className="link mr-1.5">{s.label}</Link> : <span key={s.label} className="mr-1.5">{s.label}</span>))}</> : "No stored item matched."} Written by {t.model}.
                        </p>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>

      <div {...panel("tasks")}>
        <Panel title="Turn notes into tasks" icon={Sparkles} id="ai-tasks">
          {projects.length === 0 ? (
            <EmptyState icon={FolderGit2} title="No project yet">Tasks live in a project. Create one first, then come back.</EmptyState>
          ) : (
            <div className="p-4"><DraftTasks projects={projects} defaultProjectId={defaultProjectId} configured /></div>
          )}
        </Panel>
      </div>

      <div {...panel("approvals")}>
        <Panel title="Waiting for your approval" icon={Sparkles} id="ai-approvals">
          <ApprovalsTab initial={approvals} />
        </Panel>
      </div>
    </div>
  );
}
