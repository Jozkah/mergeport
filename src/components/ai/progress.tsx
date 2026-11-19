"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "@/components/ui/icons";

export type JobResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Runs one of the AI jobs and keeps the steps the server reports while it works, so the page can say what is happening. */
export function useAiJob() {
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  const run = useCallback(async <T,>(url: string, body: unknown): Promise<JobResult<T>> => {
    setSteps([]);
    setElapsed(0);
    started.current = Date.now();
    setRunning(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error ?? "Could not reach Mergeport." };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let out: JobResult<T> | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line) as { type: string; text?: string; data?: T; error?: string };
          if (m.type === "step" && m.text) setSteps((s) => [...s, m.text!]);
          else if (m.type === "result") out = { ok: true, data: m.data as T };
          else if (m.type === "error") out = { ok: false, error: m.error ?? "That did not work." };
        }
        if (done) break;
      }
      return out ?? { ok: false, error: "The connection ended before an answer arrived. Try again." };
    } catch {
      return { ok: false, error: "Could not reach Mergeport. Check that it is still running." };
    } finally {
      setRunning(false);
    }
  }, []);

  return { steps, running, elapsed, run };
}

/** The steps so far: finished ones with a check, the current one with a spinner and the time it has taken. */
export function Progress({ steps, running, elapsed }: { steps: string[]; running: boolean; elapsed: number }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1 rounded-[10px] border border-line bg-faint p-3 text-[12.5px]" aria-live="polite" aria-label="Progress">
      {steps.map((s, i) => {
        const current = running && i === steps.length - 1;
        return (
          <li key={i} className={`flex items-start gap-2 ${current ? "text-ink" : "text-ink-3"}`}>
            {current ? <LoaderCircle size={13} aria-hidden className="mt-0.5 shrink-0 animate-spin" /> : <Check size={13} aria-hidden className="mt-0.5 shrink-0 text-ok" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{s}{current && elapsed >= 3 ? <span className="tnum text-ink-3"> · {elapsed} s</span> : null}</span>
          </li>
        );
      })}
    </ol>
  );
}
