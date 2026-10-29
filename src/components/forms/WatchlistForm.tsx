"use client";

import { useState, useTransition } from "react";
import { watchlistAction } from "@/app/actions";
import { Check, CircleAlert } from "@/components/ui/icons";

type Result = { raw: string; ok: boolean; notes: string[]; error?: string };

/**
 * Paste many repositories and follow them all. One address per line follows it (and its parent when GitHub says it is a fork);
 * "fork upstream" on one line pairs two repositories even when GitHub does not call the first a fork. Each line reports its own result.
 */
export function WatchlistForm() {
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    start(async () => {
      const r = await watchlistAction({ text });
      if (!r.ok) return setError(r.error);
      const list = (r.data?.results ?? []) as Result[];
      setResults(list);
      // Keep only the lines that failed, so the person can fix them and add again.
      setText(list.filter((x) => !x.ok).map((x) => x.raw).join("\n"));
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <label className="label" htmlFor="wl-text">Repositories to watch</label>
        <textarea
          id="wl-text"
          className="textarea min-h-40 font-mono text-[12.5px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={"https://github.com/janhq/jan\nhttps://github.com/Jozkah/flint\nhttps://github.com/AI-Cluster-Kewaii/1cat-vllm-pxa  https://github.com/1CatAI/1Cat-vLLM"}
        />
        <p className="mt-1 text-[12px] text-ink-3">One address per line. A fork on GitHub is compared with its parent. To compare any two repositories, put the fork first and its upstream second on the same line. Private repositories need your GitHub sign-in to be able to read them. Nothing is shared with teammates.</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={pending || !text.trim()} onClick={submit}>{pending ? "Adding…" : "Add to watchlist"}</button>
        {pending && <span className="text-[12.5px] text-ink-3">Looking each one up on GitHub…</span>}
        {error && <span role="alert" className="inline-flex items-center gap-1 text-[12.5px] text-blocked"><CircleAlert size={14} aria-hidden /> {error}</span>}
      </div>
      {results && (
        <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line" aria-label="Result for each line">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2 px-3 py-2 text-[12.5px]">
              {r.ok ? <Check size={14} aria-hidden className="mt-0.5 shrink-0 text-ok" /> : <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-blocked" />}
              <span className="min-w-0">
                <span className="block break-all font-mono text-ink-2">{r.raw}</span>
                <span className={r.ok ? "text-ink-3" : "text-blocked"}>{r.ok ? r.notes.join(". ") : r.error}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
