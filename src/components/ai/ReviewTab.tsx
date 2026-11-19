"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptSuggestionsAction, dismissSuggestionsAction } from "@/app/ai-actions";
import { Progress, useAiJob } from "@/components/ai/progress";

export type Suggestion = { id: string; title: string; reason: string; href: string };
type Result = { summary: string; model: string; counts: { created: number; suggested: number; skipped: number }; suggestions: Suggestion[] };

const LEVEL = { off: "Autopilot is off.", suggest: "Autopilot leaves suggestions each morning.", create: "Autopilot leaves suggestions and creates tasks for clear cases each morning." } as const;

/** The AI reads everything Mergeport knows for you and proposes tasks. You decide: nothing becomes a task until you accept it (autopilot "create" aside). */
export function ReviewTab({ initial, summary, lastRun, autopilot }: { initial: Suggestion[]; summary: string | null; lastRun: string | null; autopilot: keyof typeof LEVEL }) {
  const router = useRouter();
  const job = useAiJob();
  const [list, setList] = useState<Suggestion[]>(initial);
  const [keep, setKeep] = useState<Record<string, boolean>>(() => Object.fromEntries(initial.map((s) => [s.id, true])));
  const [text, setText] = useState<string | null>(summary);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = list.filter((s) => keep[s.id]);

  const analyze = async () => {
    setError(null);
    setNote(null);
    const r = await job.run<Result>("/api/ai/review", {});
    if (!r.ok) return setError(r.error);
    setText(r.data.summary || null);
    setList(r.data.suggestions);
    setKeep(Object.fromEntries(r.data.suggestions.map((s) => [s.id, true])));
    const c = r.data.counts;
    setNote(!r.data.model ? null : c.suggested + c.skipped === 0 ? "Nothing new to suggest right now." : `${c.suggested} new suggestion${c.suggested === 1 ? "" : "s"}${c.skipped ? `, ${c.skipped} already suggested before` : ""}. Drafted with ${r.data.model}.`);
  };

  const act = (kind: "accept" | "dismiss") =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("ids", JSON.stringify(chosen.map((s) => s.id)));
      const r = await (kind === "accept" ? acceptSuggestionsAction(fd) : dismissSuggestionsAction(fd));
      if (!r.ok) return setError(r.error);
      setList((l) => l.filter((s) => !keep[s.id]));
      setNote(r.message ?? null);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[12px] border border-line p-4">
        <p className="text-[13px] text-ink-2">The AI reads your review queues, blocked and waiting pull requests, your tasks and repositories that will not sync, then suggests what to do. {LEVEL[autopilot]}{lastRun ? ` Last review ${lastRun}.` : ""}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={analyze} disabled={job.running || pending}>{job.running ? "Working…" : "Analyze my workspace"}</button>
          <p className="text-[12px] text-ink-3">Titles and status of the items it looks at are sent to your AI address. Nothing is sent to GitHub.</p>
        </div>
        {job.steps.length > 0 && <div className="mt-3"><Progress steps={job.steps} running={job.running} elapsed={job.elapsed} /></div>}
        {error && <p role="alert" className="mt-3 text-[12.5px] text-blocked">{error}</p>}
        {note && !error && <p role="status" className="mt-3 text-[12.5px] text-ink-2">{note}</p>}
      </div>

      {text && (
        <div className="rounded-[12px] border border-line p-4">
          <p className="text-[12px] font-medium text-ink-3">Today</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">{text}</p>
        </div>
      )}

      {list.length > 0 && (
        <div className="rounded-[12px] border border-line">
          <p className="border-b border-line px-4 py-2.5 text-[13px] font-medium">Suggested tasks <span className="tnum text-ink-3">{list.length}</span></p>
          <ul>
            {list.map((s) => (
              <li key={s.id} className="border-b border-line last:border-b-0">
                <label className="flex cursor-pointer items-start gap-2.5 px-4 py-3">
                  <input type="checkbox" className="mt-1" checked={keep[s.id] ?? false} onChange={(e) => setKeep({ ...keep, [s.id]: e.target.checked })} />
                  <span className="min-w-0 text-[13px]">
                    <span className="block font-medium [overflow-wrap:anywhere]">{s.title}</span>
                    {s.reason && <span className="block text-[12px] text-ink-3 [overflow-wrap:anywhere]">{s.reason}</span>}
                    {s.href && <Link href={s.href} className="text-[12px] underline" onClick={(e) => e.stopPropagation()}>Open the pull request</Link>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <button type="button" className="btn btn-primary" onClick={() => act("accept")} disabled={pending || chosen.length === 0}>{pending ? "Working…" : `Create ${chosen.length} task${chosen.length === 1 ? "" : "s"}`}</button>
            <button type="button" className="btn btn-quiet" onClick={() => act("dismiss")} disabled={pending || chosen.length === 0}>Dismiss selected</button>
          </div>
        </div>
      )}
    </div>
  );
}
