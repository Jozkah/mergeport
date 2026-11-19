"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { acceptSuggestionsAction, dismissSuggestionsAction } from "@/app/ai-actions";
import { AiTool } from "@/components/ai/AiTool";
import { Progress, useAiJob } from "@/components/ai/progress";
import { LoaderCircle, Sparkles } from "@/components/ui/icons";

export type Suggestion = { id: string; title: string; reason: string; href: string };
type Result = { summary: string; model: string; counts: { created: number; suggested: number; skipped: number }; suggestions: Suggestion[] };

const LEVEL = { off: "Autopilot is off.", suggest: "Each morning the AI leaves suggestions here.", create: "Each morning the AI leaves suggestions and creates tasks for clear cases." } as const;

/**
 * Your day, in three parts under one header: what the AI makes of everything waiting on you, the tasks it suggests (you decide),
 * and the quick briefings. Sections are divided by rules, not boxed: the panel is already the frame.
 */
export function TodayTab({ initial, summary, lastRun, autopilot }: { initial: Suggestion[]; summary: string | null; lastRun: string | null; autopilot: keyof typeof LEVEL }) {
  const router = useRouter();
  const job = useAiJob();
  const [list, setList] = useState<Suggestion[]>(initial);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [keep, setKeep] = useState<Record<string, boolean>>(() => Object.fromEntries(initial.map((s) => [s.id, true])));
  const [text, setText] = useState<string | null>(summary);
  const [fresh, setFresh] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; tasks?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const status = useRef<HTMLParagraphElement>(null);
  const live = list.filter((s) => !leaving.has(s.id));
  const chosen = live.filter((s) => keep[s.id]);

  const analyze = async () => {
    if (job.running) return;
    setNote(null);
    const r = await job.run<Result>("/api/ai/review", {});
    if (!r.ok) return setNote({ ok: false, text: r.error });
    setText(r.data.summary || null);
    setFresh(true);
    setList(r.data.suggestions);
    setLeaving(new Set());
    setKeep(Object.fromEntries(r.data.suggestions.map((s) => [s.id, true])));
    const c = r.data.counts;
    setNote(!r.data.model ? null : { ok: true, text: c.suggested + c.skipped === 0 ? "Nothing new to suggest right now." : `${c.suggested} new suggestion${c.suggested === 1 ? "" : "s"}${c.skipped ? `, ${c.skipped} suggested before` : ""}. Written by ${r.data.model}.` });
  };

  const act = (kind: "accept" | "dismiss") =>
    start(async () => {
      const ids = chosen.map((s) => s.id);
      const fd = new FormData();
      fd.set("ids", JSON.stringify(ids));
      const r = await (kind === "accept" ? acceptSuggestionsAction(fd) : dismissSuggestionsAction(fd));
      if (!r.ok) return setNote({ ok: false, text: r.error });
      setLeaving((l) => new Set([...l, ...ids])); // they fold away, then leave the list (onAnimationEnd below)
      setNote({ ok: true, text: r.message ?? "Done", tasks: kind === "accept" });
      status.current?.focus();
      router.refresh();
    });

  return (
    <div data-no-glow className="flex flex-col divide-y divide-line">
      <section className="flex flex-col gap-3 p-4" aria-label="What the AI makes of your day">
        {text ? (
          <p className={`text-[13.5px] leading-6 text-pretty [overflow-wrap:anywhere] ${fresh ? "result-in" : ""}`}>{text}</p>
        ) : (
          <p className="text-[13px] text-ink-3 text-pretty">Nothing yet. Press the button and the AI reads everything waiting on you and says what matters.</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button type="button" className="btn btn-primary !pl-2.5" onClick={analyze} aria-disabled={job.running} aria-busy={job.running}>
            {job.running ? <LoaderCircle size={14} aria-hidden className="animate-spin" /> : <Sparkles size={14} aria-hidden />} {job.running ? "Working…" : "Review my workspace"}
          </button>
          <span className="text-[12px] text-ink-3 text-pretty">{LEVEL[autopilot]}{lastRun ? ` Last review ${lastRun}.` : ""}</span>
        </div>
        {(job.running || job.steps.length > 0) && <Progress steps={job.steps} running={job.running} elapsed={job.elapsed} />}
        <p ref={status} tabIndex={-1} role="status" className={`text-[12.5px] outline-none text-pretty ${note ? (note.ok ? "text-ink-2" : "text-blocked") : "sr-only"}`}>
          {note?.text}
          {note?.tasks && <> <Link href="/tasks" className="link">Open Tasks</Link></>}
          {note && !note.ok && <> <button type="button" className="underline" onClick={analyze}>Try again</button></>}
        </p>
      </section>

      {list.length > 0 && (
        <section aria-label="Suggested tasks">
          <h3 className="px-4 pt-3 text-[13px] font-medium">Suggested tasks <span className="tnum text-ink-3">{live.length}</span></h3>
          <ul className="flex flex-col" style={{ "--row-gap": "0px" } as React.CSSProperties}>
            {list.map((s) => (
              <li key={s.id} className={leaving.has(s.id) ? "row-leave" : undefined} onAnimationEnd={() => leaving.has(s.id) && setList((l) => l.filter((x) => x.id !== s.id))}>
                <div className="border-b border-line last:border-b-0">
                  <label className="flex cursor-pointer items-start gap-2.5 px-4 py-3">
                    <input type="checkbox" className="mt-1" checked={keep[s.id] ?? false} onChange={(e) => setKeep({ ...keep, [s.id]: e.target.checked })} />
                    <span className="min-w-0 text-[13px]">
                      <span className="block font-medium text-pretty [overflow-wrap:anywhere]">{s.title}</span>
                      {s.reason && <span className="block text-[12px] text-ink-3 text-pretty [overflow-wrap:anywhere]">{s.reason}</span>}
                      {s.href && <Link href={s.href} className="link inline-block py-1 text-[12px]" onClick={(e) => e.stopPropagation()}>Open the pull request</Link>}
                    </span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <button type="button" className="btn btn-primary" onClick={() => act("accept")} disabled={pending || chosen.length === 0}>{pending ? "Working…" : <>Create <span className="tnum">{chosen.length}</span> task{chosen.length === 1 ? "" : "s"}</>}</button>
            <button type="button" className="btn btn-quiet" onClick={() => act("dismiss")} disabled={pending || chosen.length === 0}>Dismiss selected</button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4 p-4" aria-label="Quick briefings">
        <AiTool bare tool="focus" label="What should I do first?" hint="Points at the pull requests, and they light up where you see them." />
        <AiTool bare tool="standup" label="Write my stand-up" hint="Yesterday, today, blocked." />
        <AiTool bare tool="digest" label="Summarize my digest" hint="A short read of your latest daily digest." />
      </section>
    </div>
  );
}
