"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "@/components/ui/icons";

export type JobResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Runs one of the AI jobs and keeps the steps the server reports while it works, so the page can say what is happening.
 * A newer run replaces an older one (its answer is ignored), leaving the page or starting again cancels the request, and a line
 * the server sent that cannot be read is skipped rather than failing the run.
 */
export function useAiJob() {
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const current = useRef(0); // id of the run whose answer still counts
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(
    () => () => {
      current.current++; // nothing from a run that outlives the page is applied
      abort.current?.abort();
    },
    [],
  );

  const run = useCallback(async <T,>(url: string, body: unknown): Promise<JobResult<T>> => {
    abort.current?.abort();
    const id = ++current.current;
    const ctl = new AbortController();
    abort.current = ctl;
    const live = () => current.current === id;
    setSteps([]);
    setElapsed(0);
    started.current = Date.now();
    setRunning(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error ?? "Could not reach Mergeport." };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let out: JobResult<T> | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let m: { type: string; text?: string; data?: T; error?: string };
            try {
              m = JSON.parse(line);
            } catch {
              continue; // a line that is not a message (a proxy's keep-alive, say) is not worth failing the run
            }
            if (m.type === "step" && m.text && live()) setSteps((s) => [...s, m.text!]);
            else if (m.type === "result") out = { ok: true, data: m.data as T };
            else if (m.type === "error") out = { ok: false, error: m.error ?? "That did not work." };
          }
          if (done) break;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      return out ?? { ok: false, error: "The connection ended before an answer arrived. Try again." };
    } catch {
      return { ok: false, error: ctl.signal.aborted ? "Cancelled." : "Could not reach Mergeport. Check that it is still running." };
    } finally {
      if (live()) setRunning(false);
    }
  }, []);

  return { steps, running, elapsed, run };
}

/**
 * The steps so far: finished ones with a check, the current one with a spinner and the time it has taken. Screen readers get the
 * current step once, in a region that exists from the start (a live region that appears with its text is often not announced);
 * the ticking seconds stay visual.
 */
export function Progress({ steps, running, elapsed }: { steps: string[]; running: boolean; elapsed: number }) {
  const now = steps[steps.length - 1] ?? "";
  return (
    <>
      <p role="status" className="sr-only">{running ? now : steps.length ? "Done" : ""}</p>
      {steps.length > 0 && (
        <ol className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-faint p-3 text-[12.5px]" aria-label="Progress">
          {steps.map((s, i) => {
            const active = running && i === steps.length - 1;
            return (
              <li key={i} className={`result-in flex items-start gap-2 ${active ? "text-ink" : "text-ink-3"}`}>
                <span key={active ? "run" : "done"} className="icon-swap mt-0.5 shrink-0">
                  {active ? <LoaderCircle size={13} aria-hidden className="animate-spin" /> : <Check size={13} aria-hidden className="text-ok" />}
                </span>
                <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">{s}{active && elapsed >= 3 ? <span aria-hidden className="tnum text-ink-3"> · {elapsed} s</span> : null}</span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
